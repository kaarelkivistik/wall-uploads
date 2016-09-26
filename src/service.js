const querystring = require("querystring");
const { createHash } = require("crypto");
const { writeFileSync, mkdirSync, lstatSync } = require("fs");
const { extname, join } = require("path");
const Promise = require("promise");
const { MongoClient, ObjectID } = require("mongodb");
const fetch = require("node-fetch");

const { AppError } = require("./util");

/* Configuration */

const allowedFormats = {
	jpeg: true,
	jpg: true,
	png: true,
	gif: true,
	webm: true
};

const { 
	storagePath = "storage",
	dbUrl = "mongodb://localhost/uploads",
	oauthClientId, 
	oauthClientSecret, 
	gitlabApiUrl, 
	oauthBaseUrl, 
	selfBaseUrl,
	webhookUrl,
} = require("minimist")(process.argv.slice(2));

let db, uploads;

/* Errors */

const unableToParseJsonError = new AppError(500, "unable to parse json", 0);
const didNotGetATokenError = new AppError(401, "did not get a token", 1);
const unauthorizedError = new AppError(401, "unauthorized", 2);
const unableToRetrieveUserDetailsError = new AppError(502, "unable to retrieve user details", 3);
const unableToContactGitlabError = new AppError(502, "unable to contact gitlab", 4);
const unableToCreateAnUploadError = new AppError(500, "unable to create an upload", 5);
const noSuitableUploadFoundOrNoAdditionalAttachmentsAllowedError = new AppError(403, "no suitable upload found or no additional attachments allowed", 6);
const illegalFileError = new AppError(400, "illegal file", 7);
const unableToAddAttachmentError = new AppError(500, "unable to add attachment", 8);
const noSuitableUploadFoundOrUploadAlreadyPublishedError = new AppError(403, "no suitable upload found or upload already published", 9);
const atLeastOneAttachmentRequiredError = new AppError(403, "at least one attachment required", 10);
const unableToPublishUploadError = new AppError(500, "unable to publish upload", 11);
const unableToGetUploadsError = new AppError(500, "unable to get uploads", 12);
const unableToNotifyWebhookError = new AppError(500, "unable to notify webhook", 13);

/* Database */

try {
	lstatSync(storagePath);
} catch(e) {
	console.log("Storage directory (%s) does not exist, creating", storagePath);

	try {
		mkdirSync(storagePath);
	} catch(e2) {
		console.log("Unable to create storage directory - exiting.");

		process.exit(1);
	}
}

MongoClient.connect(dbUrl).then(result => {
	console.log("Connected to %s", dbUrl);

	db = result;
	uploads = db.collection("uploads");
}, error => {
	console.error("Unable to connect to %s", dbUrl);
	console.error(error);

	process.exit(1);
});

/* Service methods */

function getTokenFor(code) {
	return fetch(oauthBaseUrl + "/token", {
		method: "POST",
		body: querystring.stringify({
			code,
			"grant_type": "authorization_code",
			"redirect_uri": selfBaseUrl + "/oauth/code",
			"client_id": oauthClientId,
			"client_secret": oauthClientSecret,
		}),
		headers: {
			"Accept": "application/json",			
		},
	}, error => {
		return Promise.reject(unableToContactGitlabError)
	}).then(response => {
		return response.json();
	}).then(result => {
		const { access_token: accessToken } = result;

		if(accessToken)
			return Promise.resolve(accessToken);
		else
			return Promise.reject(didNotGetATokenError);
	}, error => {
		return Promise.reject(unableToParseJsonError);
	});
}

function retrieveUserDetails(token) {
	return fetch(gitlabApiUrl + "/user", {
		headers: {
			"Authorization": "Bearer " + token,
			"Accept": "application/json",
		}
	}).then(response => {
		switch(response.status) {
			case 200:
				return response.json();
			case 401:
				return Promise.reject(unauthorizedError);
			default:
				return Promise.reject(unableToRetrieveUserDetailsError);
		}
	}, error => {
		return Promise.reject(unableToContactGitlabError);
	}).then(undefined, error => {
		if(error !== unauthorizedError || error !== unableToRetrieveUserDetailsError)
			return Promise.reject(unableToParseJsonError);
		else
			return Promise.reject(error);
	});
}

function createUpload(user) {
	if(!user)
		throw new Error("User must be provided to create an upload");

	return uploads.insertOne({
		user,
		published: false,
		allowAdditionalAttachments: true,
		attachments: [],
		timestamp: new Date(),
	}).then(result => {
		return {
			id: result.insertedId
		};
	}, error => {
		return Promise.reject(unableToCreateAnUploadError);
	});
}

function addAttachmentToUpload(content, filename, uploadId, userId) {
	return uploads.findOne({
		"_id": ObjectID(uploadId),
		"user.id": userId,
		"allowAdditionalAttachments": true,
		"published": false
	}).then(result => {
		if(result == null) {
			return Promise.reject(noSuitableUploadFoundOrNoAdditionalAttachmentsAllowedError)
		} else {
			const newName = persistAttachment(content, filename);

			if(newName == null) {
				return Promise.reject(illegalFileError);
			} else {
				return uploads.findOneAndUpdate({
					"_id": result._id
				}, {
					$set: {
						"allowAdditionalAttachments": false
					},
					$push: {
						"attachments": newName
					}
				}).then(undefined, error => {
					return Promise.reject(unableToAddAttachmentError);
				});
			}
		}
	}, error => {
		return Promise.reject(unableToAddAttachmentError);
	});
}

function persistAttachment(base64content, filename) {
	const extension = extname(filename).substr(1).toLowerCase();

	if(extension.length < 2 || !allowedFormats[extension]) {
		console.log("Discarding %s", Filename);
		return null;
	}

	content = Buffer.from(base64content, "base64");

	const hash = createHash("md5").update(content).digest("hex");
	const generatedFilename = hash + "." + extension;

	console.log("Writing attachment to %s", generatedFilename);
	try {
		writeFileSync(join(storagePath, generatedFilename), content);
	} catch(e) {
		log("There was an error writing file:", e);
	}

	console.log("%s written!", generatedFilename);

	return generatedFilename;
}

function publishUpload(uploadId, userId) {
	return uploads.findOne({
		"_id": ObjectID(uploadId),
		"user.id": userId,
		"published": false,
	}).then(result => {
		if(result == null) {
			return Promise.reject(noSuitableUploadFoundOrUploadAlreadyPublishedError);
		} else if(result.attachments.length == 0) {
			return Promise.reject(atLeastOneAttachmentRequiredError);
		} else {
			return uploads.findOneAndUpdate({
				"_id": result._id
			}, {
				$set: {
					"published": true
				}
			}).then(result => {
				notifyWebhook(result.value).then(() => {
					console.log("notified webhook @ %s", webhookUrl);
				}, error => {
					console.error("unable to notify webhook:", error);
				});
			}, error => {
				return Promise.reject(unableToPublishUploadError);
			});
		}
	}, error => {
		return Promise.reject(unableToPublishUploadError);
	});
}

function notifyWebhook(upload) {
	if(!webhookUrl)
		return Promise.reject(new Error("Webhook url not defined"));

	return fetch(webhookUrl, {
		method: "POST",
		body: JSON.stringify(upload),
		headers: {
			"Content-Type": "application/json",
		},
	}).then(response => {
		if(response.status !== 200)
			return Promise.reject(unableToNotifyWebhookError);
	}, error => {
		return Promise.reject(unableToNotifyWebhookError);
	});
}

function getUploads(startingFrom, limit) {
	let query = {
		published: true
	};

	if(startingFrom)
		query.timestamp = {
			$lt: startingFrom
		};

	return uploads.find(query).sort("timestamp", -1).limit(limit).toArray().then(results => {
		return results;	
	}, error => {
		return Promise.reject(unableToGetUploadsError);
	});
}

exports.getTokenFor = getTokenFor;
exports.retrieveUserDetails = retrieveUserDetails;
exports.createUpload = createUpload;
exports.addAttachmentToUpload = addAttachmentToUpload;
exports.publishUpload = publishUpload;
exports.getUploads = getUploads;
