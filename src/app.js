const { createServer } = require("http");
const { createHash } = require("crypto");
const { writeFileSync } = require("fs");
const { extname, join } = require("path");
const Promise = require("promise");
const express = require("express");
const { MongoClient } = require("mongodb");
const busboy = require("express-busboy");
const cors = require("cors");
const { Server: WebSocketServer } = require("ws");

/* App configuration */

const argv = require("minimist")(process.argv.slice(2));

const storagePath = "storage";
const allowedFormats = {
	jpeg: true,
	jpg: true,
	png: true,
	gif: true,
	webm: true
};

const { db: dbUrl = "mongodb://localhost/uploads", port = 80 } = argv;

let db, uploads, clients = new Set();

const server = createServer();

const wss = new WebSocketServer({server});
const api = express();

server.on("request", api);

/* WebSocketServer configuration */

wss.on("connection", socket => {
	clients.add(socket);

	socket.on("close", () => {
		clients.delete(socket);
	});
});

/* Express configuration */

function throwError(message) {
	throw new Error(message);
}

function errorHandler(err, req, res, next) {
	console.error("error!", err.message);

	res.status(500).send({
		error: err.message
	});
}

busboy.extend(api);

api.use(cors());

console.log("Connecting to %s", dbUrl);
MongoClient.connect(dbUrl).then(result => {
	console.log("Connected to %s", dbUrl);

	db = result;
	uploads = db.collection("uploads");

	server.listen(port);
	console.log("Listening on port %s", port);
}, error => {
	console.error("Unable to connect to %s", dbUrl);
	console.error(error);
});

api.get("/", (req, res) => {
	getUploads().then(result => {
		res.send(result);
	}, throwError);
});

api.post("/", (req, res) => {
	persistUpload(req.body).then(notifyClients, throwError);

	res.end();
});

api.use(errorHandler);

/* Service layer */

function persistUpload(body) {
	return new Promise((resolve, reject) => {
		const { mailinMsg } = body;
		const parsedMessage = JSON.parse(mailinMsg);
		const { subject, text, html, from, to, attachments: originalAttachments } = parsedMessage;

		const attachments = originalAttachments.map(attachment => {
			return persistAttachment(attachment, body[attachment.fileName]);
		}).filter(hash => {
			return hash !== null	
		});

		const upload = {
			subject, text, html, from, to, attachments
		};

		uploads.insert(upload).then(result => {
			resolve(upload);
		}, error => {
			reject(error);
		});
	});
}

function getUploads() {
	return new Promise((resolve, reject) => {
		uploads.find().toArray().then(resolve, reject);
	});
}

function notifyClients(upload) {
	for(let client of clients)
		client.send(JSON.stringify(upload))
}

function persistAttachment(attachment, content) {
	const { checksum, fileName } = attachment;

	const buffer = Buffer.from(content, "base64");
	const extension = extname(fileName);

	if(extension.length < 2)
		return null;

	if(!allowedFormats[extension.substr(1)])
		return null;

	const generatedFileName = checksum + extension;

	writeFileSync(join(storagePath, generatedFileName), buffer);

	return generatedFileName;
}
