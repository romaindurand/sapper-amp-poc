// copied from https://github.com/sveltejs/sapper/blob/master/runtime/src/server/middleware/detect_client_only_references.ts

function convertThrownError(fn, convertError) {
	try {
		const result = fn();

		if (result instanceof Promise) {
			return result.catch(e => {
				throw convertError(e);
			});
		} else {
			return result;
		}
	} catch (e) {
		throw convertError(e);
	}
}

/**
 * If the code executing in fn() tries to access `window` or `document`, throw
 * an explanatory error. Also works if fn() is async.
 */
export default function detectClientOnlyReferences(fn) {
	return convertThrownError(fn, e => {
		const m = e.message.match('(document|window) is not defined');

		if (m && e.name === 'ReferenceError') {
			e.message = `Server-side code is attempting to access the global variable "${m[1]}", which is client only. See https://sapper.svelte.dev/docs/#Server-side_rendering`;
		}

		return e;
	});
}