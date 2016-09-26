class AppError extends Error {

	constructor(httpCode, message, appErrorCode) {
		super();

		this.httpCode = httpCode;
		this.appErrorCode = appErrorCode;
		this.message = message;
	}

}

function exitOnSignal(signal) {
	process.on(signal, function() {
		console.log("Shutting down.. (%s)", signal);
		
		process.exit(0);
	});
}

exports.AppError = AppError;
exports.exitOnSignal = exitOnSignal;
