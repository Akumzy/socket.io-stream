import addSeconds from 'date-fns/add_seconds'
type cb = (...data: any) => void
interface options {
  file: File
  data?: any
  highWaterMark?: number
  maxWait?: number
}
class ClientWeb {
  filesize = 0
  id: string | null = null
  file: File
  data: any
  isPaused: boolean = false
  event: string = ''
  events: Map<string, cb[]> = new Map()
  fileReader: FileReader = new FileReader()
  private bytesPerChunk = 102400 //100kb
  private chunks = 0
  private isResume: boolean
  private maxWait: number
  private isFirst = true
  private maxWaitCounter = 0
  private maxWaitTimer: NodeJS.Timeout | null = null
  private callback: cb
  constructor(
    private socket: SocketIOClient.Socket,
    { file, data, highWaterMark, maxWait = 60 }: options,
    private eventNamespace = 'akuma'
  ) {
    this.file = file
    this.filesize = file.size
    this.socket = socket
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
    const slice = this.file.slice(start, end)
    this.fileReader.readAsArrayBuffer(slice)
    this.fileReader.onload = () => {
      // avoid resending extra infos after first upload
      if (this.isFirst || this.isResume) {
        this.socket.emit(`__${this.eventNamespace}_::data::${this.id}__`, {
          chunk: this.fileReader.result,
          info: {
            size: this.filesize,
            data: this.data
          },
          event: this.event
        })
      } else {
        this.socket.emit(`__${this.eventNamespace}_::data::${this.id}__`, {
          chunk: this.fileReader.result
        })
      }
      this.emit('progress', { size: this.filesize, total: this.chunks })
      this.isFirst = false
      this.isResume = false
      this.__maxWaitMonitor()
    }
  }
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
  private __start() {
    // listen for new request
    this.socket
      .on(`__${this.eventNamespace}_::more::${this.id}__`, this.__onMore)
      // listen for resume request
      .on(`__${this.eventNamespace}_::resume::${this.id}__`, this.__onResume)
      // listen for end event
      .once(`__${this.eventNamespace}_::end::${this.id}__`, this.__onEnd)
      .once(
        `__${this.eventNamespace}_::canceled::${this.id}__`,
        (reason: any) => {
          this.__destroy()
          this.emit('cancel', reason)
        }
      )
    this.__read(0, this.bytesPerChunk)
  }

  public upload(event: string, cb: cb) {
    this.callback = cb
    this.event = event
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
      this.on('ready', () => {
        clearInterval(timer)
        this.__start()
      })
    }

    return this
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

  on(eventName: string, cb: cb) {
    if (!this.events.get(eventName)) {
      this.events.set(eventName, [cb])
    } else {
      let e = this.events.get(eventName)
      //@ts-ignore
      e.push(cb)
    }
  }
  emit(eventName: string, data?: any) {
    const event = this.events.get(eventName)
    if (event) {
      event.forEach(cb => {
        cb.call(null, data)
      })
    }
  }
}
export default ClientWeb
