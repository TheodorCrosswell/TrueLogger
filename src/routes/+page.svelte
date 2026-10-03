<script lang="ts">
	import { db, type Invoice, type Photo } from '$lib/db';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let invoices = $state<Invoice[]>([]);
	let isLoading = $state(true);

	// Import/Export & Selection State
	let selectedIds = $state<number[]>([]);
	let showExportModal = $state(false);
	let showImportModal = $state(false);
	let exportJson = $state('');
	let importJson = $state('');
	let isProcessing = $state(false);

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
			locations: newLocations,
			// Copy Contractor & Customer Details
			contractorName: plainInvoice.contractorName,
			contractorAddress: plainInvoice.contractorAddress,
			customerName: plainInvoice.customerName,
			customerAddress: plainInvoice.customerAddress
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
		// Also remove from selection if it was selected
		selectedIds = selectedIds.filter(selectedId => selectedId !== id);
	}

	// --- Import / Export Logic ---

	function toggleSelection(id: number | undefined) {
		if (id === undefined) return;
		if (selectedIds.includes(id)) {
			selectedIds = selectedIds.filter((i) => i !== id);
		} else {
			selectedIds = [...selectedIds, id];
		}
	}

	function toggleAll() {
		if (selectedIds.length === invoices.length && invoices.length > 0) {
			selectedIds = [];
		} else {
			selectedIds = invoices.map((i) => i.id).filter((id) => id !== undefined) as number[];
		}
	}

	async function exportSelected() {
		if (selectedIds.length === 0) return;
		isProcessing = true;
		try {
			const exportedInvoices: Invoice[] = [];
			const exportedPhotos: Photo[] = [];

			for (const id of selectedIds) {
				const inv = await db.invoices.get(id);
				if (inv) {
					exportedInvoices.push(inv);
					const photos = await db.photos.where('invoiceId').equals(id).toArray();
					exportedPhotos.push(...photos);
				}
			}

			const payload = {
				invoices: exportedInvoices,
				photos: exportedPhotos
			};

			exportJson = JSON.stringify(payload);
			showExportModal = true;
		} catch (err) {
			console.error('Export failed', err);
			alert('Failed to export. See console for details.');
		} finally {
			isProcessing = false;
		}
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(exportJson);
			alert('Copied to clipboard!');
		} catch {
			alert('Failed to copy. The text might be too large; try selecting it all manually.');
		}
	}

	async function runImport() {
		if (!importJson.trim()) return;
		isProcessing = true;
		try {
			const payload = JSON.parse(importJson);
			if (!payload.invoices || !payload.photos) {
				throw new Error("Invalid format. Expected 'invoices' and 'photos' arrays.");
			}

			await db.transaction('rw', db.invoices, db.photos, async () => {
				for (const oldInv of payload.invoices) {
					const oldId = oldInv.id;
					delete oldInv.id; // Allow IndexedDB to auto-assign a fresh unique ID
					
					const newId = await db.invoices.add(oldInv);

					// Map the old invoiceId onto the imported photos
					const relatedPhotos = payload.photos.filter((p: Photo) => p.invoiceId === oldId);
					for (const p of relatedPhotos) {
						delete p.id; // Fresh photo ID
						p.invoiceId = newId; // Map to newly generated invoice ID
					}
					
					if (relatedPhotos.length > 0) {
						await db.photos.bulkAdd(relatedPhotos);
					}
				}
			});

			// Refresh UI
			invoices = await db.invoices.orderBy('createdAt').reverse().toArray();
			showImportModal = false;
			importJson = '';
			alert('Import successful!');
		} catch (err) {
			console.error('Import failed', err);
			alert('Import failed: ' + (err instanceof Error ? err.message : String(err)));
		} finally {
			isProcessing = false;
		}
	}
</script>

<header>
	<h1>Invoices</h1>
</header>

{#if isLoading}
	<p>Loading...</p>
{:else}
	<div class="top-actions">
		<button onclick={createNewInvoice}>+ Create New Invoice</button>
		<button onclick={() => showImportModal = true}>Import JSON</button>
		{#if selectedIds.length > 0}
			<button onclick={exportSelected} disabled={isProcessing}>
				{isProcessing ? 'Processing...' : `Export Selected (${selectedIds.length})`}
			</button>
		{/if}
	</div>

	{#if invoices.length === 0}
		<div class="empty-state">
			<p>No invoices found.</p>
			<button onclick={createNewInvoice}>Create First Invoice</button>
		</div>
	{:else}
		<div class="selection-actions">
			<label>
				<input 
					type="checkbox" 
					checked={selectedIds.length === invoices.length && invoices.length > 0} 
					onchange={toggleAll}
				/>
				Select All
			</label>
		</div>

		<div class="invoice-list">
			{#each invoices as invoice (invoice.id)}
				<div class="invoice-card {selectedIds.includes(invoice.id!) ? 'selected' : ''}">
					<div class="card-header">
						<input 
							type="checkbox" 
							class="select-checkbox"
							checked={selectedIds.includes(invoice.id!)}
							onchange={() => toggleSelection(invoice.id!)} 
						/>
						<h3 class="card-title">{invoice.title}</h3>
					</div>
					
					<div class="card-body">
						<p>Locations: {invoice.locations.length}</p>
						<p>Created: {new Date(invoice.createdAt).toLocaleDateString()}</p>
					</div>
					
					<div class="actions">
						<button onclick={() => goto(resolve(`/invoice/${invoice.id}`))}>Open</button>
						<button class="reuse" onclick={() => reuseInvoice(invoice)}>Reuse for Next Cycle</button>
						<button class="delete" onclick={() => deleteInvoice(invoice.id)}>Delete</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
{/if}

<!-- EXPORT MODAL -->
{#if showExportModal}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay" onclick={() => showExportModal = false}>
		<div class="modal-content" onclick={e => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Export JSON</h3>
				<button class="danger-icon" onclick={() => showExportModal = false}>&times;</button>
			</div>
			<div class="modal-body">
				<p>Copy the raw JSON text below to paste into another instance.</p>
				<p class="warning-text">Warning: Text may be very large depending on the number of photos.</p>
				<textarea class="json-textarea" readonly value={exportJson}></textarea>
			</div>
			<div class="modal-footer">
				<button class="cancel-btn" onclick={() => showExportModal = false}>Close</button>
				<button class="save-btn" onclick={copyToClipboard}>Copy to Clipboard</button>
			</div>
		</div>
	</div>
{/if}

<!-- IMPORT MODAL -->
{#if showImportModal}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay" onclick={() => showImportModal = false}>
		<div class="modal-content" onclick={e => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Import JSON</h3>
				<button class="danger-icon" onclick={() => showImportModal = false}>&times;</button>
			</div>
			<div class="modal-body">
				<p>Paste the raw JSON text exported from another instance:</p>
				<textarea 
					class="json-textarea" 
					bind:value={importJson} 
					placeholder={'{"invoices": [...], "photos": [...] }'}
				></textarea>
			</div>
			<div class="modal-footer">
				<button class="cancel-btn" onclick={() => showImportModal = false} disabled={isProcessing}>Cancel</button>
				<button class="save-btn" onclick={runImport} disabled={isProcessing || !importJson.trim()}>
					{isProcessing ? 'Importing...' : 'Import Data'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.top-actions {
		display: flex;
		gap: 1rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}
	.selection-actions {
		margin-bottom: 0.5rem;
		padding: 0 0.5rem;
	}
	.selection-actions label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 500;
		color: #4b5563;
		cursor: pointer;
	}
	
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
		transition: border-color 0.2s, box-shadow 0.2s;
		border: 1px solid transparent;
	}
	.invoice-card.selected {
		border-color: #3b82f6;
		box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
	}
	.card-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}
	.select-checkbox {
		width: 1.25rem;
		height: 1.25rem;
		cursor: pointer;
	}
	.card-title {
		margin: 0;
	}
	.card-body p {
		margin: 0.25rem 0;
		color: #4b5563;
		padding-left: 2rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
		padding-left: 2rem;
		flex-wrap: wrap;
	}
	
	/* Buttons */
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
	.danger-icon {
		background: none;
		border: none;
		color: #ef4444;
		font-size: 1.5rem;
		line-height: 1;
		cursor: pointer;
		padding: 0;
	}

	/* Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0; left: 0; right: 0; bottom: 0;
		background: rgba(0,0,0,0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 1rem;
	}
	.modal-content {
		background: white;
		width: 100%;
		max-width: 700px;
		max-height: 90vh;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		box-shadow: 0 4px 12px rgba(0,0,0,0.2);
	}
	.modal-header {
		padding: 1rem 1.5rem;
		border-bottom: 1px solid #e5e7eb;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.modal-header h3 {
		margin: 0;
		font-size: 1.25rem;
		color: #111827;
	}
	.modal-body {
		padding: 1.5rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.warning-text {
		color: #d97706;
		font-size: 0.85rem;
		margin: 0 0 0.5rem 0;
	}
	.json-textarea {
		width: 100%;
		box-sizing: border-box;
		height: 300px;
		padding: 0.75rem;
		font-family: monospace;
		font-size: 0.85rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		resize: vertical;
		white-space: pre-wrap;
	}
	.modal-footer {
		padding: 1rem 1.5rem;
		border-top: 1px solid #e5e7eb;
		display: flex;
		justify-content: flex-end;
		gap: 1rem;
	}
	.cancel-btn {
		padding: 0.5rem 1rem;
		background: white;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		cursor: pointer;
		font-weight: 500;
	}
	.cancel-btn:hover {
		background: #f3f4f6;
	}
	.save-btn {
		padding: 0.5rem 1rem;
		background: #3b82f6;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-weight: 500;
	}
	.save-btn:hover {
		background: #2563eb;
	}
	.save-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>