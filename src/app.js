const { createServer } = require("http");
const { createHash } = require("crypto");
const { writeFileSync, mkdirSync, lstatSync } = require("fs");
const { extname, join } = require("path");
const Promise = require("promise");
const express = require("express");
const { MongoClient } = require("mongodb");
const busboy = require("express-busboy");
const cors = require("cors");
const { Server: WebSocketServer } = require("ws");
const mailin = require("mailin");

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

const { db: dbUrl = "mongodb://localhost/uploads", port = 80, smtpPort = 25 } = argv;

let db, uploads, clients = new Set();

const server = createServer();

const wss = new WebSocketServer({server});
const api = express();

server.on("request", api);

/* Storage */

try {
	lstatSync(storagePath);
} catch(e) {
	log("Storage directory (%s) does not exist, creating", storagePath);

	try {
		mkdirSync(storagePath);
	} catch(e2) {
		log("Unable to create storage directory - exiting.");

		process.exit(1);
	}
}

/* Mailin */

mailin.start({
	port: smtpPort,
	disableWebhook: true
});

mailin.on("message", function (connection, data, content) {
	persistUpload(data).then(notifyClients, throwError);
});

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
	log("There was an error:", err);

	res.status(500).send({
		error: err.message,
		stack: err.stack
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
	const { startingFrom: rawStartingFrom, limit: rawLimit } = req.query;

	const startingFrom = rawStartingFrom ? new Date(rawStartingFrom) : undefined;
	const limit = parseInt(rawLimit);

	getUploads(startingFrom, limit).then(result => {
		res.send(result);
	}, throwError);
});

api.use(errorHandler);

/* Service layer */

function persistUpload(mail) {
	log("Persisting upload..");

	return new Promise((resolve, reject) => {
		const { subject, text, html, from, to, attachments: originalAttachments } = mail;

		const attachments = originalAttachments.map(attachment => {
			return persistAttachment(attachment);
		}).filter(hash => {
			return hash !== null	
		});

		const upload = {
			subject, text, html, from, to, attachments,
			timestamp: new Date()
		};

		log("Saving email to MongoDB..");
		log(upload);

		uploads.insert(upload).then(result => {
			log("Saved!")

			resolve(upload);
		}, error => {
			reject(error);
		});
	});
}

function getUploads(startingFrom, limit = 3) {
	let query = {};

	if(startingFrom)
		query.timestamp = {
			$lt: startingFrom
		};

	return new Promise((resolve, reject) => {
		uploads.find(query).limit(limit).toArray().then(resolve, reject);
	});
}

function notifyClients(upload) {
	log("Notifying %s client(s)", clients.size);

	for(let client of clients)
		client.send(JSON.stringify(upload))
}

function persistAttachment(attachment) {
	const { checksum, fileName, content } = attachment;

	const extension = extname(fileName).substr(1).toLowerCase();

	if(extension.length < 2 || !allowedFormats[extension]) {
		log("Discarding %s", fileName);
		return null;
	}

	const generatedFileName = checksum + "." + extension;

	log("Writing attachment to %s", generatedFileName);
	try {
		writeFileSync(join(storagePath, generatedFileName), content);
	} catch(e) {
		log("There was an error writing file:", e);
	}

	log("%s written!", generatedFileName);

	return generatedFileName;
}

/* Misc */

function log() {
	console.log.apply(console, arguments);
}

function exitOnSignal(signal) {
	process.on(signal, function() {
		console.log("Shutting down.. (%s)", signal);
		
		db.close();
		
		process.exit(0);
	});
}

exitOnSignal("SIGTERM");
exitOnSignal("SIGINT");
