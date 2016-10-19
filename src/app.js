const { createServer } = require("http");
const querystring = require("querystring");
const Promise = require("promise");
const express = require("express");
const busboy = require("express-busboy");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const { AppError, exitOnSignal } = require("./util");
const {
	getTokenFor,
	retrieveUserDetails,
	createUpload,
	addAttachmentToUpload,
	publishUpload,
	getUploads,
} = require("./service");

const { 
	port = "80",
	oauthClientId, 
	oauthBaseUrl, 
	selfBaseUrl,
} = require("minimist")(process.argv.slice(2));

const server = createServer();
const api = express();

server.on("request", api);

/* Express configuration */

function errorHandler(err, req, res, next) {
	console.error("There was an error:", err);

	if(err instanceof AppError)
		res.status(err.httpCode).send({
			message: err.message,
			code: err.appErrorCode,
		});
	else
		res.status(500).send({
			message: "Internal server error"
		});
}

function authorizationMiddleware(req, res, next) {
	const { authorization = "none none" } = req.headers;

	const [ bearer, token ] = authorization.split(" ");

	retrieveUserDetails(token).then(user => {
		req.user = user;

		next();
	}, next);
}

busboy.extend(api);
api.use(cors());
server.listen(port);

/* Routes */

const redirectUrls = {}

api.get("/authenticate", (req, res) => {
	const { redirect_url: redirectUrl } = req.query;

	const state = crypto.randomBytes(20).toString("hex");

	redirectUrls[state] = redirectUrl;

	res.redirect(oauthBaseUrl 
		+ "/authorize?client_id=" + oauthClientId 
		+ "&redirect_uri=" + selfBaseUrl + "/oauth/code&response_type=code" 
		+ "&state=" + state)
});

api.get("/oauth/code", (req, res, next) => {
	const { code, state } = req.query;

	getTokenFor(code).then(token => {
		const redirectUrl = redirectUrls[state]

		if(redirectUrl)
			res.redirect(redirectUrl + "?token=" + token);
		else
			res.send({token});
	}, next);
});

api.get("/", (req, res, next) => {
	const { startingFrom: rawStartingFrom, limit: rawLimit } = req.query;

	const startingFrom = rawStartingFrom ? new Date(rawStartingFrom) : undefined;
	const limit = Math.min(parseInt(rawLimit) || 3, 36);

	getUploads(startingFrom, limit).then(result => {
		res.send(result);
	}, next);
});

api.get("/me", authorizationMiddleware, (req, res) => {
	const { user } = req;

	res.send({
		user
	});
});

api.post("/", authorizationMiddleware, (req, res) => {
	createUpload(req.user).then(result => {
		res.send(result);
	});
});

api.post("/uploads/:uploadId/attachment", authorizationMiddleware, (req, res, next) => {
	const { uploadId } = req.params;
	const { content, filename } = req.body;
	
	addAttachmentToUpload(content, filename, uploadId, req.user.id).then(() => {
		res.end();
	}, next);
});

api.patch("/uploads/:uploadId", authorizationMiddleware, (req, res, next) => {
	const { uploadId } = req.params;
	const { published } = req.body;
	
	publishUpload(uploadId, req.user.id).then(() => {
		res.end();
	}, next);
});

api.use(errorHandler);

/* Support */

exitOnSignal("SIGTERM");
exitOnSignal("SIGINT");
