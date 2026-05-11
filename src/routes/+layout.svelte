<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>TrueLogger</title>
</svelte:head>

<main>
	{@render children()}
</main>

<style>
	:global(body) {
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
		background-color: #f3f4f6;
		margin: 0;
		padding: 0;
		color: #1f2937;
	}
	:global(main) {
		max-width: 800px;
		margin: 0 auto;
		padding: 1rem;
	}
	:global(button) {
		background-color: #10b981;
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		cursor: pointer;
		font-weight: bold;
	}
	:global(button:hover) {
		background-color: #059669;
	}
	:global(button.danger) {
		background-color: #ef4444;
	}
	:global(input[type='text'], input[type='number'], textarea, select) {
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		width: 100%;
		box-sizing: border-box;
	}
</style>
