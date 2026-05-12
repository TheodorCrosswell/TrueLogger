<script lang="ts">
	import { db, type Invoice } from '$lib/db';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let invoices = $state<Invoice[]>([]);
	let isLoading = $state(true);

	onMount(async () => {
		invoices = await db.invoices.orderBy('createdAt').reverse().toArray();
		isLoading = false;
	});

	async function createNewInvoice() {
		const id = await db.invoices.add({
			title: `Invoice - ${new Date().toLocaleDateString()}`,
			createdAt: Date.now(),
			locations: []
		});
		goto(resolve(`/invoice/${id}`));
	}

	async function reuseInvoice(oldInvoice: Invoice) {
		// 1. Unwrap Svelte 5 Proxies using $state.snapshot() so IndexedDB can safely clone it
		const plainInvoice = $state.snapshot(oldInvoice);

		// Duplicates invoice structure but resets status and notes
		const newLocations = plainInvoice.locations.map((loc) => ({
			...loc,
			serviced: false,
			notes: ''
		}));
		
		const id = await db.invoices.add({
			title: `Invoice - ${new Date().toLocaleDateString()}`,
			createdAt: Date.now(),
			locations: newLocations
		});
		
		goto(resolve(`/invoice/${id}`));
	}

	async function deleteInvoice(id: number | undefined) {
		if (id === undefined) return;
		
		const confirmed = confirm('Are you sure you want to delete this invoice? All associated photos will also be deleted.');
		if (!confirmed) return;

		// Use a transaction to ensure both the invoice and its photos are deleted safely
		await db.transaction('rw', db.invoices, db.photos, async () => {
			await db.photos.where('invoiceId').equals(id).delete();
			await db.invoices.delete(id);
		});

		// Remove the deleted invoice from the local Svelte state to update the UI
		invoices = invoices.filter((invoice) => invoice.id !== id);
	}
</script>

<header>
	<h1>Invoices</h1>
</header>

{#if isLoading}
	<p>Loading...</p>
{:else if invoices.length === 0}
	<div class="empty-state">
		<p>No invoices found.</p>
		<button onclick={createNewInvoice}>Create First Invoice</button>
	</div>
{:else}
	<button style="margin-bottom: 1rem;" onclick={createNewInvoice}>+ Create New Invoice</button>

	<div class="invoice-list">
		{#each invoices as invoice (invoice.id)}
			<div class="invoice-card">
				<h3>{invoice.title}</h3>
				<p>Locations: {invoice.locations.length}</p>
				<p>Created: {new Date(invoice.createdAt).toLocaleDateString()}</p>
				<div class="actions">
					<button onclick={() => goto(resolve(`/invoice/${invoice.id}`))}>Open</button>
					<button class="reuse" onclick={() => reuseInvoice(invoice)}>Reuse for Next Cycle</button>
					<button class="delete" onclick={() => deleteInvoice(invoice.id)}>Delete</button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.empty-state {
		text-align: center;
		padding: 3rem;
		background: white;
		border-radius: 8px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}
	.invoice-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.invoice-card {
		background: white;
		padding: 1rem;
		border-radius: 8px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
		flex-wrap: wrap;
	}
	.reuse {
		background-color: #3b82f6;
		color: white;
	}
	.delete {
		background-color: #ef4444;
		color: white;
	}
	.delete:hover {
		background-color: #dc2626;
	}
</style>