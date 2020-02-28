#!/usr/bin/env node

import HTTP from "http";
import EventEmitter from "events";
import {fileURLToPath} from "url";
import getOpts from "get-options";
import {
	clamp,
	uint64ToBytes,
	utf8Decode,
	utf8Encode,
	wsDecodeFrame,
	wsEncodeFrame,
	wsHandshake,
} from "alhadis.utils";


// Run if executed directly
const path = fileURLToPath(import.meta.url);
(process.argv[1] === path || globalThis.$0 === path) && (async () => {
	await Promise.resolve(); // TDZ hack
	
	const {options, argv} = getOpts(process.argv.slice(2), {
		"-p, --port": "[number=\\d+]",
	}, {noMixedOrder: true, noUndefined: true, terminator: "--"});
	const port = +options.port || 1338;
	const server = new Server();
	server.listen(port);
	console.log(`[PID: ${process.pid}] WebSocket server listening on port ${port}`);
	
})().catch(error => {
	console.error(error);
	process.exit(1);
});


/**
 * Handler for a single WebSocket connection.
 * @class
 */
export class Channel extends EventEmitter{
	#maxSize      = Number.MAX_SAFE_INTEGER;
	#closed       = false;
	#sendPromise  = null;
	frameBuffer   = [];
	inputBuffer   = [];
	inputPending  = false;
	inputType     = "binary";
	outputBuffer  = [];
	outputPending = false;
	
	/**
	 * Create a new WebSocket connection.
	 *
	 * @param {net.Socket} socket
	 * @constructor
	 */
	constructor(socket){
		super();
		this.socket = socket;
		this.socket.on("data", this.readBytes.bind(this));
	}
	
	
	/**
	 * Whether or not the client has disconnected.
	 *
	 * @property {Boolean} closed
	 * @readonly
	 */
	get closed(){
		return this.#closed;
	}
	
	
	/**
	 * Maximum payload-length permitted for any single data frame.
	 *
	 * @property {Number} maxSize
	 * @default Number.MAX_SAFE_INTEGER
	 */
	get maxSize(){
		return this.#maxSize;
	}
	set maxSize(to){
		this.#maxSize = clamp(~~Number(to), 1, Number.MAX_SAFE_INTEGER);
	}
	
	
	/**
	 * Terminate the connection.
	 *
	 * @param {Number} [code=1000]
	 * @param {String} [reason=""]
	 * @return {Promise<void>}
	 */
	async close(code = 1000, reason = ""){
		if(this.#closed) return;
		this.#closed = true;
		const payload = code ? [code >> 8 & 255, code & 255, ...utf8Decode(reason)] : [];
		this.socket.write(wsEncodeFrame({opcode: 0x08, isFinal: true, payload}));
		this.emit("ws:close", code, reason);
		return new Promise(done => this.socket.end(done));
	}
	
	
	/**
	 * Handle raw bytes sent from the client.
	 *
	 * @param {Buffer} data
	 * @return {void}
	 */
	readBytes(data){
		if(this.#closed) return;
		this.frameBuffer.push(...data);
		const {frames, trailer} = decode(this.frameBuffer);
		this.frameBuffer = trailer;
		for(const frame of frames)
			this.readFrame(frame);
	}
	
	
	/**
	 * Process a decoded WebSocket frame.
	 *
	 * @param {WSFrame} frame
	 * @return {void}
	 */
	readFrame(frame){
		if(this.#closed) return;
		switch(frame.opname){
			case "ping": this.emit("ws:ping", frame); return this.pong();
			case "pong": this.emit("ws:pong", frame); return;
			case "binary":
			case "text":
				if(this.inputBuffer.length)
					this.emit("ws:incomplete-message", this.inputBuffer, this.inputType);
				this.inputBuffer = [...frame.payload];
				this.inputType = frame.opname;
				break;
			case "continue":
				if(!this.inputPending) return; // Not expecting any data
				this.inputBuffer = this.inputBuffer.concat(frame.payload);
				break;
			case "close":
				this.#closed = true;
				if(frame.payload.length){
					const code = (255 & frame.payload[0]) << 8 | 255 & frame.payload[1];
					const reason = utf8Encode(frame.payload.slice(2));
					this.emit("ws:close", code, reason);
				}
				else this.emit("ws:close");
		}
		
		// Data frame
		if(frame.opcode < 0x08){
			if(frame.isFinal){
				const message = "text" === this.inputType
					? utf8Encode(this.inputBuffer)
					: Buffer.from(this.inputBuffer);
				this.inputBuffer = [];
				this.inputPending = false;
				this.emit("ws:message", message);
			}
			else this.inputPending = true;
		}
	}
	
	
	/**
	 * Send arbitrary data to the client.
	 *
	 * @param {FrameData|WSFrame[]} data - Message to transmit
	 * @param {Boolean} [raw=false] - Treat input as pre-encoded frames
	 * @return {void}
	 */
	send(data, raw = false){
		if(this.#closed) return;
		this.outputBuffer.push(...raw ? data : encode(data, this.maxSize));
		this.sendNext();
	}
	
	
	/**
	 * Send the next pending data-frame.
	 *
	 * @internal
	 * @return {Promise<void>}
	 */
	async sendNext(){
		if(this.#closed) return;
		await this.#sendPromise;
		const frame = this.outputBuffer.shift();
		if(!frame) return;
		await (this.#sendPromise = new Promise(resolve =>
			this.socket.write(frame, null, resolve)));
		this.outputBuffer.length && this.sendNext();
	}
	
	
	/**
	 * Send a "ping" frame to the client.
	 * @return {void}
	 */
	ping(){
		if(this.#closed) return;
		const frame = wsEncodeFrame({isFinal: true, opcode: 0x09});
		this.socket.write(frame);
	}
	
	
	/**
	 * Send a "pong" frame to the client.
	 * @return {void}
	 */
	pong(){
		if(this.#closed) return;
		const frame = wsEncodeFrame({isFinal: true, opcode: 0x0A});
		this.socket.write(frame);
	}
}


/**
 * A WebSocket-only webserver.
 * @class
 */
export class Server extends HTTP.Server{
	channels = new Map();
	
	/**
	 * Initialise a new WebSocket server.
	 * @constructor
	 */
	constructor(){
		super();
		this.on("request", this.handleRequest.bind(this));
	}
	
	
	/**
	 * Iterate through all open channels.
	 * @return {MapIterator}
	 */
	[Symbol.iterator](){
		return this.channels.values();
	}
	
	
	/**
	 * Close all open channels, then shutdown the server.
	 *
	 * @param {Number} [code=1001]
	 * @param {String} [reason=""]
	 * @return {Promise<void>}
	 */
	async close(code = 1001, reason = ""){
		for(const channel of this)
			await channel.close(code, reason);
		return new Promise(done => super.close(done));
	}
	
	
	/**
	 * Respond to an incoming request.
	 *
	 * @param {HTTP.IncomingMessage} request
	 * @param {HTTP.ServerResponse} response
	 * @return {Promise<void>}
	 */
	async handleRequest(request, response){
		if(!this.listening) return;
		if(!isHandshake(request)){
			response.writeHead(400, {"Content-Type": "text/plain; charset=UTF-8"});
			response.write("Not a WebSocket handshake");
			response.end();
		}
		else if(!this.isConnected(request)){
			const accept = wsHandshake(request.headers["sec-websocket-key"]);
			response.writeHead(101, {
				"Sec-WebSocket-Accept": accept,
				Connection: "Upgrade",
				Upgrade: "websocket",
			});
			response.end();
			this.upgrade(request);
		}
	}
	
	
	/**
	 * Determine if a client has a WebSocket connection open.
	 *
	 * @param {HTTP.IncomingMessage|net.Socket} client
	 * @return {Boolean}
	 */
	isConnected(client){
		if(client instanceof HTTP.IncomingMessage)
			client = client.socket;
		return this.channels.has(client);
	}
	
	
	/**
	 * Broadcast a message to all open channels.
	 *
	 * @param {FrameData} data
	 * @return {void}
	 */
	send(data){
		data = encode(data);
		for(const channel of this)
			channel.send(data, true);
	}
	
	
	/**
	 * Establish a WebSocket connection with a client.
	 *
	 * @emits ws:open
	 * @param {HTTP.IncomingMessage} request
	 * @return {Channel}
	 */
	upgrade({socket}){
		const channel = new Channel(socket);
		this.channels.set(socket, channel);
		channel.id = this.channels.size;
		this.emit("ws:open", channel);
		for(const event of "close incomplete-message message ping pong".split(" "))
			channel.on(`ws:${event}`, (...args) => this.emit(`ws:${event}`, channel, ...args));
		channel.once("ws:close", () => {
			this.channels.delete(socket);
			channel.removeAllListeners();
		});
		return channel;
	}
}


/**
 * Determine if an incoming request is attempting a WebSocket handshake.
 * @param {IncomingMessage} request
 * @return {Boolean}
 */
export function isHandshake(request){
	return request
		&& request.httpVersion >= 1.1
		&& request.headers
		&& request.headers["sec-websocket-key"]
		&& "websocket" === request.headers.upgrade
		&& "Upgrade"   === request.headers.connection
		&& "GET"       === request.method;
}


/**
 * Decode a byte-stream as a sequence of WebSocket frames.
 * @param {Number[]} data
 * @return {{frames: WSFrame[], trailer: Number[]}}
 */
export function decode(data){
	const frames = [];
	let frame;
	do{
		frame = wsDecodeFrame(data);
		if(BigInt(frame.payload.length) < frame.length)
			break;
		data = frame.trailer;
		frames.push(frame);
	} while(data.length);
	for(const frame of frames)
		frame.trailer = [];
	return {frames, trailer: data};
}


/**
 * Encode a message as a sequence of data frames.
 * @param {FrameData} data
 * @param {Number} [maxSize=Infinity]
 * @return {WSFrame[]}
 */
export function encode(data, maxSize = Infinity){
	let opcode = 0x02;
	if("string" === typeof data){
		data = utf8Decode(data);
		opcode = 0x01;
	}
	else data = [...data];
	const frames = [];
	do{
		frames.push(wsEncodeFrame({
			payload: data.splice(0, maxSize),
			isFinal: !data.length,
			opcode,
		}));
		opcode = 0x00;
	} while(data.length > 0);
	return frames;
}


/**
 * Content to encode for a data frame.
 * @typedef {String|Uint8Array|Buffer} FrameData
 */



/**
 * Convert a list of values to a compact binary representation.
 * @param {...*} args
 * @return {Uint8Array}
 */
export function pack(...args){
	const result = [];
	for(const arg of args)
		result.push(...packValue(arg));
	result.unshift(...uint64ToBytes(BigInt(args.length)));
	return Uint8Array.from(result);
}


/**
 * Decode a packed list of encoded arguments.
 * @param {Number[]|Uint8Array}
 * @return {Array}
 */
export function unpack(bytes){
	bytes = Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes;
	const view = new DataView(bytes.buffer);
	const size = Number(view.getBigUint64(0));
	let offset = 8;
	const args = new Array(size);
	for(let i = 0; offset < bytes.byteLength && i < size;){
		const [size, value] = unpackValue(bytes.subarray(offset));
		offset += size;
		args[i++] = value;
	}
	return args;
}


/**
 * Convert a single value to a binary representation.
 * @param {*} input
 * @return {Number[]}
 * @internal
 */
export function packValue(input){
	if(Number.isNaN(input))  return [0x02];
	if(Object.is(input, -0)) return [0x07];
	switch(input){
		case undefined: return [0x00];
		case null:      return [0x01];
		case true:      return [0x03];
		case false:     return [0x04];
		case Infinity:  return [0x05];
		case -Infinity: return [0x06];
	}
	let bytes, size, type;
	switch(input.constructor){
		case Number:
		case BigInt:
			// Float
			if(~~input !== input){
				bytes = new DataView(new ArrayBuffer(8));
				bytes.setFloat64(0, Number(input));
				return [26, ...new Uint8Array(bytes.buffer)];
			}
			// Unsigned integer
			else if((input = BigInt(input)) >= 0n){
				if(input <= 255n)                  [size, type] = [1, "Uint8"];
				else if(input <= (2n ** 16n) - 1n) [size, type] = [2, "Uint16"];
				else if(input <= (2n ** 32n) - 1n) [size, type] = [4, "Uint32"];
				else if(input <= (2n ** 64n) - 1n) [size, type] = [8, "Uint64"];
			}
			// Signed integer
			else if(input < 0n){
				if(input >= -127n)                  [size, type] = [1, "Int8"];
				else if(input >= -(2n ** 15n) + 1n) [size, type] = [2, "Int16"];
				else if(input >= -(2n ** 31n) + 1n) [size, type] = [4, "Int32"];
				else if(input >= -(2n ** 63n) + 1n) [size, type] = [8, "Int64"];
			}
			// Too-damn-big integer
			if(!type){
				type  = input < 0 ? (input = -input, 28) : 27;
				input = input.toString(16);
				bytes = input.padStart(input.length + (input.length % 2), "0").match(/.{2}/g);
				size  = uint64ToBytes(BigInt(bytes.length));
				return [type, ...size, ...new Uint8Array(bytes.map(x => parseInt(x, 16)))];
			}
			bytes = new DataView(new ArrayBuffer(size));
			type.endsWith("64") ? bytes["setBig" + type](0, input) : bytes["set" + type](0, Number(input));
			type = "Uint8 Uint16 Uint32 Uint64 Int8 Int16 Int32 Int64".split(" ").indexOf(type) + 8;
			return [type, ...new Uint8Array(bytes.buffer)];
		
		case Uint8Array:     case Int8Array:
		case Uint16Array:    case Int16Array:
		case Uint32Array:    case Int32Array:
		case BigUint64Array: case BigInt64Array:
		case Float32Array:   case Float64Array:
			bytes = new Uint8Array(input.buffer);
			size = uint64ToBytes(BigInt(bytes.length));
			type = [
				Uint8Array,   Uint16Array, Uint32Array, BigUint64Array,
				Int8Array,    Int16Array,  Int32Array,  BigInt64Array,
				Float32Array, Float64Array,
			].indexOf(input.constructor) + 16;
			return [type, ...size, ...bytes];
		
		case Date:
			input = "Invalid Date" === input.toString() ? input.toString() : input.toISOString();
			input = utf8Decode(input);
			size = BigInt(input.length);
			return [29, ...uint64ToBytes(size), ...input];
		
		case String:
			input = utf8Decode(input);
			size = BigInt(input.length);
			return [30, ...uint64ToBytes(size), ...input];
		
		case RegExp:
			let flags = 0;
			if(input.global)     flags |= 1;
			if(input.ignoreCase) flags |= 1 << 1;
			if(input.multiline)  flags |= 1 << 2;
			if(input.dotAll)     flags |= 1 << 3;
			if(input.unicode)    flags |= 1 << 4;
			if(input.sticky)     flags |= 1 << 5;
			input = utf8Decode(input.source);
			size  = uint64ToBytes(BigInt(input.length));
			return [31, ...size, flags, ...input];
		
		default:
			input = utf8Decode(JSON.stringify(input));
			size = uint64ToBytes(BigInt(input.length));
			return [32, ...size, ...input];
	}
}


/**
 * Decode the binary representation of a single value.
 * @param {Uint8Array} bytes
 * @return {Array.<BigInt, *>}
 * @internal
 */
export function unpackValue(input){
	if(!input || !input.length)
		throw new TypeError("Cannot unpack empty buffer");
	const [type] = input;
	const view = new DataView(input.buffer, input.byteOffset + 1);
	const size = view.byteLength >= 8 ? Number(view.getBigUint64(0)) : 0;
	switch(type){
		case 0: return [1, undefined];
		case 1: return [1, null];
		case 2: return [1, NaN];
		case 3: return [1, true];
		case 4: return [1, false];
		case 5: return [1, Infinity];
		case 6: return [1, -Infinity];
		case 7: return [1, -0];
	}
	// Single number (predetermined size)
	if(type > 7 && type < 16 || 26 === type)
		switch(type){
			case 8:  return [2, view.getUint8(0)];
			case 9:  return [3, view.getUint16(0)];
			case 10: return [5, view.getUint32(0)];
			case 11: return [9, view.getBigUint64(0)];
			case 12: return [2, view.getInt8(0)];
			case 13: return [3, view.getInt16(0)];
			case 14: return [5, view.getInt32(0)];
			case 15: return [9, view.getBigInt64(0)];
			case 26: return [9, view.getFloat64(0)];
		}
	
	// Multiple numbers
	if(type > 15 && type < 26){
		const list = [
			Uint8Array,   Uint16Array, Uint32Array, BigUint64Array,
			Int8Array,    Int16Array,  Int32Array,  BigInt64Array,
			Float32Array, Float64Array,
		][type - 16];
		return [9, new list(input.slice(9, 9 + (size * list.BYTES_PER_ELEMENT)).buffer)];
	}
	
	// BigInt (variable-length)
	if(27 === type || 28 === type){
		input = [...input.subarray(9, 9 + size)].map(x => x.toString(16).padStart(2, "0"));
		return [9 + size, BigInt("0x" + input.join("")) * (28 === type ? -1n : 1n)];
	}
	
	// RegExp
	if(31 === type){
		const flags = view.getUint8(8);
		let flagStr = "";
		if(flags & 1)      flagStr += "g";
		if(flags & 1 << 1) flagStr += "i";
		if(flags & 1 << 2) flagStr += "m";
		if(flags & 1 << 3) flagStr += "s";
		if(flags & 1 << 4) flagStr += "u";
		if(flags & 1 << 5) flagStr += "y";
		return [10 + size, new RegExp(utf8Encode(input.subarray(10, 10 + size)), flagStr)];
	}
	
	// String-like data
	input = utf8Encode(input.subarray(9, 9 + size));
	switch(type){
		case 29: return [9 + size, new Date(input)];
		case 30: return [9 + size, input];
		case 32: return [9 + size, JSON.parse(input)];
	}
	
	// Unknown/invalid type
	throw new TypeError(`Unrecognised type identifier: 0x${type.toString(16).toUpperCase()}`);
}
