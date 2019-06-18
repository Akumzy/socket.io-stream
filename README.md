# socket.io-stream

socket.io based file stream

This package has three components

- ### Client:

  Only works in Nodejs environment like in ElectronJs.

- ### Web:

  Web is for browsers baseds app the component uses FileReader api to read file blob.

- ### Server:
  This component handlers all the request from both `Web` and `Client`

```js
//Client
import { Client } from '@akumzy/socket.io-stream'

const client = new Client(socket, {
  filepath: '/path/to/file/music.mp3',
  data: {
    //you pass your own data here
    name: 'music.mp3'
  }
})

client
  .upload('file-upload', data => {
    console.log({ data })
  })
  .on('progress', c => {
    console.log(c) //{total,size}
  })
  .on('done', data => {
    console.log(data)
  })
  .on('pause', () => {
    console.log('pause')
  })
  .on('cancel', () => {
    console.log('canceled')
  })
```

```js
//Web

function onChange(inputElement) {
  let file = inputElement.files[0]

  const client = new Web(socket, {
    file: file,
    data: {
      name: file.name
    }
  })
  client
    .upload('file-upload', data => {
      console.log({ data })
    })
    .on('progress', c => {
      console.log(c) //{total,size}
    })
    .on('done', data => {
      console.log(data)
    })
    .on('pause', () => {
      console.log('pause')
    })
    .on('cancel', () => {
      console.log('canceled')
    })
}
```

```js
//Server
import { Server } from '@akumzy/socket.io-stream'
import { appendFile } from 'fs'
const io = require('socket.io')(8090)

io.on('connection', socket => {
  const server = new Server(socket)

  server.on('file-upload', async ({ stream, data, ready }, ack) => {
    try {
      await someTask()
      ready()
      stream.subscribe({
        next({ buffer, flag }) {
          appendFile(data.name, buffer, {
            encoding: 'binary',
            flag
          })
        },
        complete() {
          ack(null, [1, 2, 3])
        },
        error(err) {
          ack(err)
          console.error(err)
        }
      })
    } catch (err) {
      console.error(err)
    }
  })
})
```

Please check the <a href="https://github.com/Akumzy/socket.io-stream/tree/master/example">example </a> folder for clue on how to use package until I'm able to document this package well
