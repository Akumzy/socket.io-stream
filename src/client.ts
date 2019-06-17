import { EventEmitter } from 'events'
import { createReadStream, existsSync, statSync, readFileSync } from 'fs'
import addSeconds from 'date-fns/add_seconds'

interface ClientOptions {
  filepath: string
  data?: any
  highWaterMark?: number
  maxWait?: number
}
type cb = (...data: any) => void
export default class Client extends EventEmitter {
  filesize = 0
  id: string | null = null
  filepath: string
  data: any
  isPaused: boolean = false
  event: string = ''
  private bytesPerChunk = 102400 //100kb
  private chunks = 0
  private maxWait: number
  private isResume = true
  private isFirst = true
  private maxWaitCounter = 0
  private maxWaitTimer: NodeJS.Timeout | null = null
  private callback: cb
  constructor(
    private socket: SocketIOClient.Socket,
    { filepath, maxWait = 60, data, highWaterMark }: ClientOptions,
    private eventNamespace = 'akuma'
  ) {
    super()
    this.filepath = filepath
    this.data = data
    this.bytesPerChunk = highWaterMark || this.bytesPerChunk
    this.maxWait = maxWait
  }
  private __getId() {
    this.socket.emit(`__${this.eventNamespace}_::new::id__`, (id: string) => {
      if (this.id) return
      this.id = id
      this.emit('ready')
    })
  }
  private __read(start: number, end: number) {
    if (this.isPaused) return
    if (this.filesize <= this.bytesPerChunk) {
      let chunk = readFileSync(this.filepath)
      this.socket.emit(`__${this.eventNamespace}_::data::${this.id}__`, {
        chunk,
        info: {
          size: this.filesize,
          data: this.data
        },
        event: this.event
      })
      this.emit('progress', { size: this.filesize, total: chunk.length })
      this.__maxWaitMonitor()
      return
    }
    const stream = createReadStream(this.filepath, {
      highWaterMark: this.bytesPerChunk,
      start,
      end
    })
    stream.read(end - start)
    //
    stream.once('data', (chunk: Buffer) => {
      // avoid resending extra infos after first upload
      this.socket.emit(`__${this.eventNamespace}_::data::${this.id}__`, {
        chunk,
        info: {
          size: this.filesize,
          data: this.data
        },
        event: this.event
      })

      stream.close()
      this.emit('progress', { size: this.filesize, total: this.chunks })
      this.isFirst = false
      this.isResume = false
      this.__maxWaitMonitor()
    })
  }
  /**
   * maximum time to wait for server to
   * respond before stoping an upload
   */
  private __maxWaitMonitor() {
    if (this.maxWaitTimer) clearInterval(this.maxWaitTimer)
    this.maxWaitTimer = setInterval(() => {
      this.maxWaitCounter += 1
      if (this.isPaused) {
        this.__clearMaxWaitMonitor()
        return
      }
      if (this.maxWaitCounter >= this.maxWait)
        this.stop('Response timeout id=' + this.id)
    }, 1000)
  }
  private __clearMaxWaitMonitor() {
    if (this.maxWaitTimer) {
      clearInterval(this.maxWaitTimer)
      this.maxWaitTimer = null
      this.maxWaitCounter = 0
    }
  }
  /**
   * more event handler
   */
  private __onMore = (offset: number) => {
    if (!offset) return
    this.chunks = offset
    let toChunk = Math.min(this.bytesPerChunk, this.filesize - offset)
    this.__clearMaxWaitMonitor()
    this.__read(offset, toChunk + offset)
  }
  /**
   * resume event handler
   */
  private __onResume = (offset: number | null) => {
    this.isResume = true
    this.__maxWaitMonitor()
    if (typeof offset === 'number') {
      this.chunks = offset
      let toChunk = Math.min(this.bytesPerChunk, this.filesize - offset)
      this.__read(offset, toChunk + offset)
    } else this.__read(0, this.bytesPerChunk)
  }
  /**
   * end event handler
   */
  private __onEnd = ({ total, payload }: any) => {
    // clear maxWait
    this.__clearMaxWaitMonitor()
    this.emit('progress', { size: this.filesize, total })
    let data = { size: this.filesize, total, payload }
    this.emit('done', data)
    if (typeof this.callback === 'function') {
      this.callback(...(payload || []))
    }
    this.__destroy()
  }
  /**
   * Start initial upload and add event listeners
   */
  private __start() {
    // listen for new request
    this.socket
      .on(`__${this.eventNamespace}_::more::${this.id}__`, this.__onMore)
      // listen for resume request
      .on(`__${this.eventNamespace}_::resume::${this.id}__`, this.__onResume)
      // listen for end event
      .on(`__${this.eventNamespace}_::end::${this.id}__`, this.__onEnd)
    this.filesize = statSync(this.filepath).size
    this.__read(0, this.bytesPerChunk)
  }

  public upload(event: string, cb: cb) {
    this.callback = cb
    this.event = event
    if (typeof this.filepath === 'string') {
      if (existsSync(this.filepath)) {
        if (this.id) this.__start()
        else {
          // get an id from server
          this.__getId()

          let whenToAbort = addSeconds(new Date(), 30).getTime()
          // Start a timer to check if the server have responded with
          // an id if not cancel the upload
          let timer = setInterval(() => {
            if (this.id) clearInterval(timer)
            else {
              // resend the get id event every 5 seconds
              this.__getId()
              if (Date.now() >= whenToAbort) {
                this.__destroy()
                this.emit('cancel', 'Get id timeout')
              }
            }
          }, 5000)
          // listen for ready event which will be emitted
          // once an id has been recieved and clear the timer
          this.once('ready', () => {
            clearInterval(timer)
            this.__start()
          })
        }
      } else {
        let text = `${this.filepath} does not exist.`
        throw new Error(text)
      }
    } else {
      let text = `${this.filepath} must be typeof string.`
      throw new Error(text)
    }

    return this
  }
  public pause() {
    this.isPaused = true
    this.socket.emit(`__${this.eventNamespace}_::pause::__`, this.id)
    this.emit('pause')
  }
  public resume() {
    if (!this.id) return
    this.isPaused = false
    this.emit('resume')
    this.socket.emit(`__${this.eventNamespace}_::resume::__`, this.id)
  }
  // Stop and destroy upload
  public stop<T>(reason?: T) {
    this.socket.emit(`__${this.eventNamespace}_::stop::__`, this.id)
    this.__destroy()
    this.emit('cancel', reason)
  }
  public __destroy() {
    this.socket
      .off(`__${this.eventNamespace}_::more::${this.id}__`, this.__onMore)
      .off(`__${this.eventNamespace}_::resume::${this.id}__`, this.__onResume)
      .off(`__${this.eventNamespace}_::end::${this.id}__`, this.__onEnd)
    this.data = null
    this.id = null
    this.__clearMaxWaitMonitor()
  }
}
