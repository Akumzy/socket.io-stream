/// <reference types="jest" />
import io from 'socket.io-client'
import http from 'http'
import ioBack from 'socket.io'
import UploaderServer from '../src/server'
import UploaderClient from '../src/client'

let socket: SocketIOClient.Socket
let httpServer: http.Server
let ioServer: ioBack.Server
let uploader: UploaderServer
/**
 * Setup WS & HTTP servers
 */
beforeAll(done => {
  httpServer = http.createServer().listen(9090)
  ioServer = ioBack(httpServer)
  ioServer.on('connection', (mySocket: SocketIO.Socket) => {
    uploader = new UploaderServer(mySocket)
  })
  done()
})

/**
 *  Cleanup WS & HTTP servers
 */
afterAll(done => {
  ioServer.close()
  httpServer.close()
  done()
})

/**
 * Run before each test
 */
beforeEach(done => {
  // Setup
  // Do not hardcode server port and address, square brackets are used for IPv6
  socket = io.connect(`http://localhost:9090`, {
    transports: ['websocket']
  })

  socket.on('connect', () => {
    done()
  })
})

/**
 * Run after each test
 */
afterEach(done => {
  // Cleanup
  if (socket.connected) {
    socket.disconnect()
  }
  done()
})

describe('Upload example', () => {
  test('Upload a file', done => {
    const options = {
      filepath:
        'C:\\Users\\akuma\\hola\\projects\\socket.io-stream\\package.json',
      data: { name: 'package.json' }
    }

    const client = new UploaderClient(socket, options)

    client.upload('upload', payload => {
      expect(payload).toEqual('yes')
      done()
    })

    uploader.on('upload', async ({ stream, data, ready }, ack) => {
      expect(data).toEqual({ name: 'package.json' })
      ready()
      stream.subscribe({
        next({ buffer }) {
          console.log(buffer)
        },
        complete() {
          ack('yes')
        },
        error() {}
      })
    })
  })
})
