# socket.io-stream

socket.io based file stream

This package has three components

- ### Client:

  Only works on node environment bacause it's uses node `fs.creatReadStream` which makes sense for electron applications.

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
io.on('connection', socket => {
	console.log('hurrey')
	const server = new Server(socket)

	server.on('file-upload', ({ stream, data: { data } }, done) => {
		console.log('stream')
		const writable = createWriteStream(data.name, {
			autoClose: true
		})
		stream.pipe(writable)
		writable.on('close', () => {
			//make sure to call this function
			//only when you're done, you can
			//pass a value to it which will be
			//sent back to client as well
			done('good')
		})
	})
})
```

Please check the <a href="https://github.com/Akumzy/socket.io-stream/tree/master/example">example </a> folder for clue on how to use package until I'm able to document this package well
