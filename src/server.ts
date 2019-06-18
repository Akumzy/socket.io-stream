import uuid from './uuid'
import addMinutes from 'date-fns/add_minutes'
import isAfter from 'date-fns/is_after'
import { Subject } from 'rxjs'
import differenceInMinutes from 'date-fns/difference_in_minutes'

interface UploadRecord {
  uploadedChunks: number
  expire: Date
  event: string
  active?: boolean
  paused: boolean
  id: string
}

interface cb {
  (...data: any): void
}
interface StreamPayload {
  buffer: Buffer
  fileSize: number
  uploadedChunks: number
  flag: string | undefined
}
interface OnDataPayload {
  chunk: Buffer
  info: { size: number; data: any }
  event: string
  withAck: boolean
}
interface Options {
  namespace?: string
  maxWait?: number
}
export type IStream = Subject<StreamPayload>
type Handler = (
  {
    stream,
    data,
    ready,
    id
  }: { stream: IStream; data: any; ready?: () => void; id: string },
  ack?: cb
) => void
// Store all the record out the Server class to persist the state
// because this Server will be instantiate inside onconnection event
const records: Map<string, UploadRecord> = new Map()

export default class Server {
  private streams: Map<string, IStream> = new Map()
  private handlers: Map<string, Handler> = new Map()
  private cleaner: NodeJS.Timeout | null = null
  private maxWait: number // numbers of minutes to add to an upload expiration time default is 10 minutes
  private namespace: string
  constructor(
    private io: SocketIO.Socket,
    options: Options = { namespace: 'akuma', maxWait: 10 }
  ) {
    this.namespace = options.namespace
    this.maxWait = options.maxWait
    //create id
    this.io.on(`__${this.namespace}_::new::id__`, (ack: cb) => {
      this.__createNew(ack)
    })
    // stop
    this.io.on(`__${this.namespace}_::stop::__`, (id: string) => {
      //close the stream
      if (this.records.has(id)) {
        let streamInstance = this.streams.get(id)
        if (streamInstance) streamInstance.error('Stream closed')
        this.cancel(id, { code: 2, message: 'Client canceled upload' })
      }
    })

    // client pause
    this.io.on(`__${this.namespace}_::pause::__`, (id: string) => {
      //close the stream
      if (this.records.has(id)) {
        let record = this.records.get(id)
        this.records.set(id, {
          ...record,
          expire: addMinutes(record.expire, 60),
          paused: true
        })
      }
    })
    //resume
    this.io.on(`__${this.namespace}_::resume::__`, this.__resume)
  }
  get records() {
    return records
  }
  private __resume = (id: string) => {
    //on resume check is this id instance still available
    //then return the total transfered buffer else
    //return nothing
    let record = this.records.get(id)
    if (record) {
      this.records.set(id, { ...record, active: false })
      this.io.emit(
        `__${this.namespace}_::resume::${id}__`,
        record.uploadedChunks
      )
      let streamInstance = this.streams.get(id)
      if (!streamInstance) {
        this.__createNew(id)
      }
    } else {
      this.__createNew(id)
      this.io.emit(`__${this.namespace}_::resume::${id}__`)
    }
  }

  private __createNew(ack?: cb | string, id?: string) {
    if (typeof id === 'string' || typeof ack === 'string') {
      let _id = typeof ack === 'string' ? ack : (id as string)
      this.__listener(_id, true)
      // Always call `__cleaner` when new upload is created
      this.__cleaner()
    } else {
      if (typeof ack === 'function') {
        let id = uuid()
        while (this.records.has(id)) {
          id = uuid()
        }
        ack(id)
        this.__listener(id)
        this.__cleaner()
      }
    }
  }

  public on(event: string, handler: Handler) {
    if (typeof event !== 'string')
      throw new Error(`${event} must be typeof string`)
    if (!this.handlers.has(event)) {
      this.handlers.set(event, handler)
    }
  }
  /**
   * cancel
   */
  public cancel(id: string, reason?: any) {
    this.io.emit(`__${this.namespace}_::canceled::${id}__`, reason)
    this.__done(id)
  }
  private __listener(id: string, resume = false) {
    const stream = new Subject<StreamPayload>()
    let isReady = false,
      isFirst = true,
      _info: { size: number; data: any }

    const whenReady = () => {
      isReady = true
    }
    // Start listening for data from this router
    this.io.on(
      `__${this.namespace}_::data::${id}__`,
      async ({ chunk, info, event }: OnDataPayload) => {
        // check if cleaner is active else call cleaner
        if (!this.cleaner) this.__cleaner()
        if (info) _info = info

        let uploadedChunks = 0
        let streamInstance = this.streams.get(id)
        let record = this.records.get(id)

        if (streamInstance) {
          if (record) {
            // If this upload has stream instance and upload record
            // update the expire property and update record
            record = {
              ...record,
              active: true, // set active true to indicate that this upload handler is already been called
              expire: this.__addTime(record.expire)
            }
            this.records.set(id, record)
          }
        } else {
          if (record) {
            this.records.set(id, {
              ...record,
              expire: this.__addTime(new Date(), true)
            })
          } else {
            this.records.set(id, {
              event,
              uploadedChunks: 0,
              paused: false,
              expire: this.__addTime(new Date(), true),
              id
            })
          }
          this.streams.set(id, stream)
          record = this.records.get(id) as UploadRecord
          streamInstance = stream
        }
        let streamPayload: StreamPayload
        if (record) {
          let flag: string | undefined
          // `flag` is used along side with `fs.appendFile` to determines which flag to use
          // fs.appendFile default flag `a` flag which means "Open file for appending. The file is created if it does not exist."
          if (!resume && isFirst) {
            // if this upload is not resume set the flag to `w` which means
            // "Open file for writing. The file is created (if it does not exist) or truncated (if it exists)."
            flag = 'w'
          }
          if (!record.active) {
            // Check if this upload already has a handler
            // else create new handler

            let handler = this.handlers.get(record.event)
            if (handler) {
              const payload = {
                stream: streamInstance,
                data: info.data,
                ready: whenReady,
                id
              }

              handler(payload, (...ack: any[]) => {
                let r = this.records.get(id)
                if (r)
                  this.io.emit(`__${this.namespace}_::end::${id}__`, {
                    payload: ack,
                    total: r.uploadedChunks
                  })
                this.__done(id)
              })

              this.records.set(id, {
                ...record,
                uploadedChunks,
                active: true
              })
            } else {
              throw new Error('a handler is required.')
            }
          }

          uploadedChunks = record.uploadedChunks + chunk.length
          this.records.set(id, { ...record, uploadedChunks })
          streamPayload = {
            buffer: Buffer.from(chunk),
            fileSize: _info.size,
            uploadedChunks: record.uploadedChunks,
            flag
          }
          /* This is just make show for any weird reasons
           * the stream observer most have a subscriber
           * before piping buffers to it
           */
          if (isFirst) {
            await new Promise(res => {
              let timer = setInterval(() => {
                if (isReady) {
                  clearInterval(timer)
                  res(true)
                }
              }, 500)
            })
            isFirst = false
          }

          /**
           * Check if transfered buffers are equal to
           * file size then emit end else request for more
           */

          if (uploadedChunks < _info.size) {
            streamInstance.next(streamPayload)
            this.io.emit(`__${this.namespace}_::more::${id}__`, uploadedChunks)
          } else {
            streamInstance.next(streamPayload)
            // wait a little to ensure that the file writing
            // is completed before calling complete
            await sleep(100)
            streamInstance.complete()
          }
        }
      }
    )
  }
  /**
   * Cleaner monitors uploads and clear expired uploads
   */
  private __cleaner() {
    this.cleaner = setInterval(() => {
      let s = this.records.size
      if (s) {
        this.records.forEach(val => {
          if (isAfter(new Date(), val.expire)) {
            let stream = this.streams.get(val.id)
            if (stream) {
              stream.error('Reconnect timeout')
            }
            this.cancel(val.id, {
              code: 1,
              message: 'Client reconnect timeout'
            })
            if (!this.records.size) {
              if (this.cleaner) clearInterval(this.cleaner)
            }
          }
        })
      } else {
        if (this.cleaner) clearInterval(this.cleaner)
        this.cleaner = null
      }
    }, 10000)
  }
  private __done(id: string) {
    setTimeout(() => {
      this.records.delete(id)
      this.handlers.delete(id)
      this.streams.delete(id)
    }, 300)
  }
  private __addTime(date: Date, isNew = false) {
    if (isNew) {
      return addMinutes(date, this.maxWait)
    }
    let diff = differenceInMinutes(date, new Date())
    if (diff <= this.maxWait) return addMinutes(date, this.maxWait - diff)
    return date
  }
}
function sleep(timeout: number) {
  return new Promise(resolve => setTimeout(() => resolve(), timeout))
}
