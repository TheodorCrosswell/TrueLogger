<script lang="ts">
	import { db, type Invoice, type Photo } from '$lib/db';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import jsPDF from 'jspdf';
	import autoTable from 'jspdf-autotable';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let invoice = $state<Invoice | undefined>(undefined);
	let photos = $state<Photo[]>([]);
	let isLoaded = $state(false);

	// Derived state groups photos natively by angle, then by before/after
	let sortedPhotos = $derived(
		[...photos].sort((a, b) => {
			if (a.angle.toLowerCase() < b.angle.toLowerCase()) return -1;
			if (a.angle.toLowerCase() > b.angle.toLowerCase()) return 1;
			if (a.type === 'before' && b.type === 'after') return -1;
			if (a.type === 'after' && b.type === 'before') return 1;
			return a.timestamp - b.timestamp;
		})
	);

	onMount(async () => {
		invoice = await db.invoices.get(data.id);
		photos = await db.photos.where('invoiceId').equals(data.id).toArray();
		isLoaded = true;
	});

	// Svelte 5 Rune Effect: Auto-save invoice to Dexie when modified
	$effect(() => {
		if (invoice && isLoaded) {
			const snap = $state.snapshot(invoice);
			db.invoices.put(snap);
		}
	});

	function addLocation() {
		if (!invoice) return;
		invoice.locations = [
			...invoice.locations,
			{
				id: crypto.randomUUID(),
				name: 'New Location',
				service: 'Mowing',
				cost: 0,
				serviced: false,
				notes: ''
			}
		];
	}

	function removeLocation(id: string) {
		if (!invoice) return;
		invoice.locations = invoice.locations.filter((l) => l.id !== id);
	}

	async function handleUpload(event: Event, locationId: string) {
		const input = event.target as HTMLInputElement;
		if (!input.files || !invoice) return;

		for (const file of input.files) {
			const dataUrl = await fileToDataUrl(file);
			const newPhoto: Photo = {
				invoiceId: invoice.id!,
				locationId,
				angle: 'Default Angle',
				type: 'before',
				dataUrl,
				timestamp: Date.now()
			};
			const photoId = await db.photos.add(newPhoto);
			photos = [...photos, { ...newPhoto, id: photoId }];
		}
		input.value = ''; // clear input
	}

	function fileToDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function updatePhoto(photo: Photo) {
		await db.photos.put($state.snapshot(photo));
		// Update array reference for reactivity
		photos = photos.map((p) => (p.id === photo.id ? photo : p));
	}

	async function deletePhoto(id: number) {
		await db.photos.delete(id);
		photos = photos.filter((p) => p.id !== id);
	}

	function exportPDF() {
		if (!invoice) return;
		const doc = new jsPDF();

		doc.setFontSize(20);
		doc.text(invoice.title, 14, 22);

		const tableData = invoice.locations.map((loc) => [
			loc.name,
			loc.service,
			loc.serviced ? 'Yes' : 'No',
			loc.notes,
			`$${loc.cost.toFixed(2)}`
		]);

		const total = invoice.locations.filter((l) => l.serviced).reduce((sum, l) => sum + l.cost, 0);

		tableData.push(['', '', '', 'GRAND TOTAL:', `$${total.toFixed(2)}`]);

		autoTable(doc, {
			startY: 30,
			head: [['Location', 'Service', 'Serviced', 'Notes', 'Cost']],
			body: tableData,
			footStyles: { fillColor: [200, 200, 200] },
			willDrawCell: (data) => {
				// highlight total row
				if (data.row.index === tableData.length - 1) {
					data.cell.styles.fontStyle = 'bold';
				}
			}
		});

		doc.save(`${invoice.title}.pdf`);
	}
</script>

{#if !isLoaded}
	<p>Loading invoice...</p>
{:else if invoice}
	<div class="header-bar">
		<button onclick={() => goto('/')}>&larr; Back</button>
		<input class="title-input" type="text" bind:value={invoice.title} />
		<button class="export-btn" onclick={exportPDF}>Export PDF</button>
	</div>

	<div class="locations">
		{#each invoice.locations as loc (loc.id)}
			<div class="location-card">
				<div class="loc-header">
					<input type="text" bind:value={loc.name} placeholder="Location Name" />
					<button class="danger" onclick={() => removeLocation(loc.id)}>X</button>
				</div>

				<div class="loc-grid">
					<label>Service: <input type="text" bind:value={loc.service} /></label>
					<label>Cost ($): <input type="number" bind:value={loc.cost} /></label>
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={loc.serviced} />
						Serviced this cycle?
					</label>
				</div>

				<textarea bind:value={loc.notes} placeholder="Notes for this location..."></textarea>

				<!-- Photo Management -->
				<div class="photo-section">
					<h4>Photos</h4>
					<input type="file" multiple accept="image/*" onchange={(e) => handleUpload(e, loc.id)} />

					<div class="photo-grid">
						{#each sortedPhotos.filter((p) => p.locationId === loc.id) as photo (photo.id)}
							<div class="photo-card">
								<img src={photo.dataUrl} alt="Lawn" />
								<div class="photo-controls">
									<input
										type="text"
										bind:value={photo.angle}
										onblur={() => updatePhoto(photo)}
										placeholder="Angle (e.g. Front)"
									/>
									<select bind:value={photo.type} onchange={() => updatePhoto(photo)}>
										<option value="before">Before</option>
										<option value="after">After</option>
									</select>
									<span class="meta">{new Date(photo.timestamp).toLocaleString()}</span>
									<button class="danger" onclick={() => deletePhoto(photo.id!)}>Delete</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{/each}
	</div>

	<button class="add-loc-btn" onclick={addLocation}>+ Add Location</button>
{/if}

<style>
	.header-bar {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-bottom: 2rem;
	}
	.title-input {
		flex: 1;
		font-size: 1.5rem;
		font-weight: bold;
	}
	.export-btn {
		background-color: #8b5cf6;
	}
	.locations {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}
	.location-card {
		background: white;
		padding: 1.5rem;
		border-radius: 8px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}
	.loc-header {
		display: flex;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.loc-grid {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: 1rem;
		align-items: end;
		margin-bottom: 1rem;
	}
	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		height: 100%;
	}
	.photo-section {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid #e5e7eb;
	}
	.photo-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 1rem;
		margin-top: 1rem;
	}
	.photo-card {
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.photo-card img {
		width: 100%;
		height: 150px;
		object-fit: cover;
	}
	.photo-controls {
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.meta {
		font-size: 0.75rem;
		color: #6b7280;
	}
	.add-loc-btn {
		margin-top: 2rem;
		width: 100%;
		padding: 1rem;
		font-size: 1.1rem;
	}
</style>
