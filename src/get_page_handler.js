// copied from https://github.com/sveltejs/sapper/blob/master/runtime/src/server/middleware/get_page_handler.ts

import { writable } from 'svelte/store';
import fs from 'fs';
import path from 'path';
import { parse } from 'cookie';
import fetch from 'node-fetch';
import URL from 'url';
import { get_file_contents, sourcemap_stacktrace } from './sourcemap_stacktrace';
import {
    build_dir,
    dev,
    src_dir
} from '@sapper/internal/manifest-server';
import App from '@sapper/internal/App.svelte';
import detectClientOnlyReferences from './detect_client_only_references';

export function get_page_handler(
	manifest,
	session_getter
) {
	const get_build_info = dev
		? () => JSON.parse(fs.readFileSync(path.join(build_dir, 'build.json'), 'utf-8'))
		: (assets => () => assets)(JSON.parse(fs.readFileSync(path.join(build_dir, 'build.json'), 'utf-8')));

	const template = dev
		? () => read_amp_template(src_dir)
		: (str => () => str)(read_amp_template(build_dir));

	const { pages, error: error_route } = manifest;

	function bail(res, err) {
		console.error(err);

		const message = dev ? escape_html(typeof err === 'string' ? err : err.message) : 'Internal server error';

		res.statusCode = 500;
		res.end(`<pre>${message}</pre>`);
	}

	function handle_error(req, res, statusCode, error) {
		handle_page({
			pattern: null,
			parts: [
				{ name: null, component: { default: error_route } }
			]
		}, req, res, statusCode, error || 'Unknown error');
	}

	async function handle_page(
        page,
        req,
        res,
        status = 200,
        error) {
		const build_info = get_build_info();

		res.setHeader('Content-Type', 'text/html');

		// preload main js and css
		// TODO detect other stuff we can preload like fonts?
		let preload_files = Array.isArray(build_info.assets.main) ? build_info.assets.main : [build_info.assets.main];
		if (build_info?.css?.main) {
			preload_files = preload_files.concat(build_info?.css?.main);
		}

		let es6_preload = false;
		if (build_info.bundler === 'rollup') {
			es6_preload = true;
			const route = page.parts[page.parts.length - 1].file;
			const deps = build_info.dependencies[route];
			if (deps) {
				preload_files = preload_files.concat(deps);
			}
		} else if (!error) {
			page.parts.forEach(part => {
				if (!part) return;
				// using concat because it could be a string or an array. thanks webpack!
				preload_files = preload_files.concat(build_info.assets[part.name]);
			});
		}

		const link = preload_files
			.filter((v, i, a) => a.indexOf(v) === i)        // remove any duplicates
			.filter(file => file && !file.match(/\.map$/))  // exclude source maps
			.map((file) => {
				const as = /\.css$/.test(file) ? 'style' : 'script';
				const rel = es6_preload && as === 'script' ? 'modulepreload' : 'preload';
				return `<${req.baseUrl}/client/${file}>;rel="${rel}";as="${as}"`;
			})
			.join(', ');

		res.setHeader('Link', link);

		let session;
		try {
			session = await session_getter(req, res);
		} catch (err) {
			return bail(res, err);
		}

		let redirect;
		let preload_error;

		const preload_context = {
			redirect: (statusCode, location) => {
				if (redirect && (redirect.statusCode !== statusCode || redirect.location !== location)) {
					throw new Error('Conflicting redirects');
				}
				location = location.replace(/^\//g, ''); // leading slash (only)
				redirect = { statusCode, location };
			},
			error: (statusCode, message) => {
				preload_error = { statusCode, message };
			},
			fetch: (url, opts) => {
				const protocol = req.socket.encrypted ? 'https' : 'http';
				const parsed = new URL.URL(url, `${protocol}://127.0.0.1:${process.env.PORT}${req.baseUrl ? req.baseUrl + '/' :''}`);

				opts = Object.assign({}, opts);

				const include_credentials = (
					opts.credentials === 'include' ||
					opts.credentials !== 'omit' && parsed.origin === `${protocol}://127.0.0.1:${process.env.PORT}`
				);

				if (include_credentials) {
					opts.headers = Object.assign({}, opts.headers);

					const cookies = Object.assign(
						{},
						parse(req.headers.cookie || ''),
						parse(opts.headers.cookie || '')
					);

					const set_cookie = res.getHeader('Set-Cookie');
					(Array.isArray(set_cookie) ? set_cookie : [set_cookie]).forEach((s) => {
						const m = /([^=]+)=([^;]+)/.exec(s);
						if (m) cookies[m[1]] = m[2];
					});

					const str = Object.keys(cookies)
						.map(key => `${key}=${cookies[key]}`)
						.join('; ');

					opts.headers.cookie = str;

					if (!opts.headers.authorization && req.headers.authorization) {
						opts.headers.authorization = req.headers.authorization;
					}
				}

				return fetch(parsed.href, opts);
			}
		};

		let preloaded;
		let match;
		let params;

		try {
			const root_preload = manifest.root_comp.preload || (() => {});
			const root_preloaded = detectClientOnlyReferences(() =>
				root_preload.call(
					preload_context,
					{
						host: req.headers.host,
						path: req.path,
						query: req.query,
						params: {}
					},
					session
				)
			);

			match = error ? null : page.pattern.exec(req.path);

			let toPreload = [root_preloaded];
			toPreload = toPreload.concat(page.parts.map(part => {
				if (!part) return null;

				// the deepest level is used below, to initialise the store
				params = part.params ? part.params(match) : {};

				return part.component.preload
					? detectClientOnlyReferences(() =>
							part.component.preload.call(
								preload_context,
								{
									host: req.headers.host,
									path: req.path,
									query: req.query,
									params
								},
								session
							)
						)
					: {};
			}));

			preloaded = await Promise.all(toPreload);
		} catch (err) {
			if (error) {
				return bail(res, err);
			}

			preload_error = { statusCode: 500, message: err };
			preloaded = []; // appease TypeScript
		}

		try {
			if (redirect) {
				const location = URL.resolve((req.baseUrl || '') + '/', redirect.location);

				res.statusCode = redirect.statusCode;
				res.setHeader('Location', location);
				res.end();

				return;
			}

			if (preload_error) {
				if (!error) {
					handle_error(req, res, preload_error.statusCode, preload_error.message);
				} else {
					bail(res, preload_error.message);
				}

				return;
			}

			const segments = req.path.split('/').filter(Boolean);

			// TODO make this less confusing
			const layout_segments = [segments[0]];
			let l = 1;

			page.parts.forEach((part, i) => {
				layout_segments[l] = segments[i + 1];
				if (!part) return null;
				l++;
			});

			if (error instanceof Error && error.stack) {
				error.stack = sourcemap_stacktrace(error.stack);
			}

			const pageContext = {
				host: req.headers.host,
				path: req.path,
				query: req.query,
				params,
				error: error
					? error instanceof Error
						? error
						: { message: error, name: 'PreloadError' }
					: null
			};

			const props = {
				stores: {
					page: {
						subscribe: writable(pageContext).subscribe
					},
					preloading: {
						subscribe: writable(null).subscribe
					},
					session: writable(session)
				},
				segments: layout_segments,
				status: error ? status : 200,
				error: pageContext.error,
				level0: {
					props: preloaded[0]
				},
				level1: {
					segment: segments[0],
					props: {}
				}
			};

			let level_index = 1;
			for (let i = 0; i < page.parts.length; i += 1) {
				const part = page.parts[i];
				if (!part) continue;

				props[`level${level_index++}`] = {
					component: part.component.default,
					props: preloaded[i + 1] || {},
					segment: segments[i]
				};
			}

			const { html, head, css } = detectClientOnlyReferences(() => App.render(props));
			const nonce_value = (res.locals && res.locals.nonce) ? res.locals.nonce : '';
			const nonce_attr = nonce_value ? ` nonce="${nonce_value}"` : '';

			let styles = '';

			// TODO make this consistent across apps
			// TODO embed build_info in placeholder.ts
			if (build_info.css && build_info.css.main) {
				styles += get_file_contents(path.join(src_dir, '../static/global.css'))
        styles += get_file_contents(path.join(build_dir, 'client', build_info.css.main[0]))
        page.parts.forEach(part => {
          if (!part || !build_info.dependencies) return
          const deps_for_part = build_info.dependencies[part.file]

          if (deps_for_part) {
            deps_for_part.filter(d => d.endsWith('.css')).forEach(chunk => {
              styles += get_file_contents(path.join(build_dir, 'client', chunk))
            })
          }
        })

			} else {
				styles = (css && css.code ? `<style${nonce_attr}>${css.code}</style>` : '');
			}

			const body = template()
				.replace('%sapper.base%', () => `<base href="${req.baseUrl}/">`)
				.replace('%sapper.html%', () => html)
				.replace('%sapper.head%', () => head)
				.replace('%sapper.styles%', () => `<style amp-custom>${styles}</style>`)
				.replace(/%sapper\.cspnonce%/g, () => nonce_value);

			res.statusCode = status;
			res.end(body);
		} catch (err) {
			if (error) {
				bail(res, err);
			} else {
				handle_error(req, res, 500, err);
			}
		}
	}

	return function find_route(req, res, next) {
		const req_path = req.path;

		const page = pages.find(p => p.pattern.test(req_path));

		if (page) {
			handle_page(page, req, res);
		} else {
			handle_error(req, res, 404, 'Not found');
		}
	};
}

function read_amp_template(dir = build_dir) {
	return fs.readFileSync(`${dir}/template_amp.html`, 'utf-8');
}

function escape_html(html) {
	const chars = {
		'"' : 'quot',
		'\'': '#39',
		'&': 'amp',
		'<' : 'lt',
		'>' : 'gt'
	};

	return html.replace(/["'&<>]/g, c => `&${chars[c]};`);
}