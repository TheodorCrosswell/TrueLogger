import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	plugins: [
		sveltekit(),
		VitePWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'TrueLogger',
				short_name: 'TrueLogger',
				description: 'PWA for managing invoices',
				theme_color: '#10b981',
				icons: [
					{
						"src": "/favicon.png",
						"sizes": "1024x1024",
						"type": "image/png"
					}
				]
			}
		})
	]
});
