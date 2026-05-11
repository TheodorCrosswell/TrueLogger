/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

declare let self: ServiceWorkerGlobalScope;

import { build, files, prerendered, version } from '$service-worker';

const CACHE = `cache-${version}`;

// Combine all the files that SvelteKit generates or serves
const ASSETS = [
	...build, // compiled JS/CSS
	...files, // static files (manifest.json, icons, etc.)
	...prerendered // prerendered pages (like index.html fallback)
];

self.addEventListener('install', (event) => {
	// Cache all essential assets on install
	async function addFilesToCache() {
		const cache = await caches.open(CACHE);
		await cache.addAll(ASSETS);
	}
	event.waitUntil(addFilesToCache());
});

self.addEventListener('activate', (event) => {
	// Clean up old caches when the app updates
	async function deleteOldCaches() {
		for (const key of await caches.keys()) {
			if (key !== CACHE) await caches.delete(key);
		}
	}
	event.waitUntil(deleteOldCaches());
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	async function respond() {
		const url = new URL(event.request.url);
		const cache = await caches.open(CACHE);

		// 1. Serve static built assets from cache first for maximum speed
		if (ASSETS.includes(url.pathname)) {
			const cachedResponse = await cache.match(url.pathname);
			if (cachedResponse) return cachedResponse;
		}

		// 2. For everything else, try the network first
		try {
			const response = await fetch(event.request);
			if (response.status === 200) {
				cache.put(event.request, response.clone());
			}
			return response;
		} catch (err) {
			// 3. If offline, try to find a cached copy
			const cachedResponse = await cache.match(event.request);
			if (cachedResponse) return cachedResponse;

			// 4. If offline and requesting a dynamic route (e.g., /invoice/123),
			// serve the fallback index.html shell so the client router can take over
			if (event.request.mode === 'navigate') {
				const fallback = await cache.match('/index.html');
				if (fallback) return fallback;
			}

			throw err;
		}
	}

	event.respondWith(respond());
});
