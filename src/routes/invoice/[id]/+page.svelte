<script lang="ts">
	import { db, type Invoice, type Photo } from '$lib/db';
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import jsPDF from 'jspdf';
	import autoTable from 'jspdf-autotable';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let invoice = $state<
		| (Invoice & {
				contractorName?: string;
				contractorAddress?: string;
				customerName?: string;
				customerAddress?: string;
				invoiceDate?: string;
				invoiceNumber?: string;
				angles?: string[];
		  })
		| undefined
	>(undefined);

	let photos = $state<Photo[]>([]);
	let isLoaded = $state(false);

	// PDF Layout State
	let photoLayout = $state<'none' | '1' | '2' | '6'>('none');
	let pdfPreviewUrl = $state<string | null>(null);

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
		if (invoice && !invoice.angles) {
			invoice.angles = ['Front', 'Back', 'Left Side', 'Right Side'];
		}
		photos = await db.photos.where('invoiceId').equals(data.id).toArray();
		isLoaded = true;
	});

	// Cleanup memory leaks from Object URLs
	onDestroy(() => {
		if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
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

	function addAngle(e: SubmitEvent) {
		e.preventDefault();
		if (!invoice) return;
		const form = e.currentTarget as HTMLFormElement;
		const input = form.querySelector('input[name="angleName"]') as HTMLInputElement;
		const trimmed = input.value.trim();
		if (!trimmed) return;

		const currentAngles = invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side'];
		if (!currentAngles.includes(trimmed)) {
			invoice.angles = [...currentAngles, trimmed];
		}
		input.value = '';
	}

	function deleteAngle(angleToDelete: string) {
		if (!invoice) return;
		const currentAngles = invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side'];
		invoice.angles = currentAngles.filter((a) => a !== angleToDelete);
	}

	async function handleUpload(event: Event, locationId: string) {
		const input = event.target as HTMLInputElement;
		if (!input.files || !invoice) return;

		const currentAngles = invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side'];
		const defaultAngle = currentAngles[0] || 'Default Angle';

		for (const file of input.files) {
			const dataUrl = await fileToDataUrl(file);
			const newPhoto: Photo = {
				invoiceId: invoice.id!,
				locationId,
				angle: defaultAngle,
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

	interface jsPDFWithAutoTable extends jsPDF {
		lastAutoTable?: {
			finalY: number;
		};
	}

	function generatePDF(action: 'download' | 'preview') {
		if (!invoice) return;
		const doc = new jsPDF();
		const pageWidth = doc.internal.pageSize.width;
		const pageHeight = doc.internal.pageSize.height;

		// --- INVOICE HEADER ---

		// Top Left: Contractor Name
		doc.setFontSize(20);
		doc.text(invoice.contractorName || 'Contractor Name', 14, 22);

		// Top Right: "INVOICE"
		doc.setFontSize(24);
		doc.text('INVOICE', pageWidth - 14, 22, { align: 'right' });

		// Left side: Contractor Address
		doc.setFontSize(10);
		if (invoice.contractorAddress) {
			const splitContractorAddress = doc.splitTextToSize(invoice.contractorAddress, 80);
			doc.text(splitContractorAddress, 14, 30);
		}

		// Right side: Date and Invoice #
		doc.text(`Date: ${invoice.invoiceDate || ''}`, pageWidth - 14, 30, { align: 'right' });
		doc.text(`Invoice #: ${invoice.invoiceNumber || ''}`, pageWidth - 14, 35, { align: 'right' });

		// Left side further down: Bill To Details
		doc.setFontSize(12);
		doc.text('Bill To:', 14, 55);
		doc.setFontSize(10);
		doc.text(invoice.customerName || 'Customer Name', 14, 61);
		if (invoice.customerAddress) {
			const splitCustomerAddress = doc.splitTextToSize(invoice.customerAddress, 80);
			doc.text(splitCustomerAddress, 14, 66);
		}

		// --- INVOICE TABLE ---
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
			startY: 85,
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

		// --- INVOICE FOOTER ---

		// Extract the Y position immediately after the table ends
		const finalY = (doc as jsPDFWithAutoTable).lastAutoTable?.finalY || 85;

		// Bottom: Payable to Check Notice
		doc.setFontSize(12);
		doc.text(
			`Make all checks payable to ${invoice.contractorName || 'Contractor'}`,
			14,
			finalY + 15
		);

		// Footer: Thank you text
		doc.setFontSize(14);
		doc.text('THANK YOU FOR YOUR BUSINESS', pageWidth / 2, pageHeight - 15, { align: 'center' });

		// --- PHOTOS LOGIC ---

		// Helper to maintain image aspect ratio within boundaries
		const fitImage = (
			props: { width: number; height: number },
			maxWidth: number,
			maxHeight: number
		) => {
			const ratio = props.width / props.height;
			let w = maxWidth;
			let h = w / ratio;
			if (h > maxHeight) {
				h = maxHeight;
				w = h * ratio;
			}
			return { w, h };
		};

		// Helper struct to construct matched pairs for 2-per-page and 6-per-page logic
		const pairs: { locationName: string; angle: string; before?: Photo; after?: Photo }[] = [];

		if (photoLayout === '2' || photoLayout === '6') {
			const grouped: Record<string, Photo[]> = {};
			for (const p of sortedPhotos) {
				const key = `${p.locationId}::${p.angle}`;
				if (!grouped[key]) grouped[key] = [];
				grouped[key].push(p);
			}

			for (const [key, photosInGroup] of Object.entries(grouped)) {
				const [locId, angle] = key.split('::');
				const locName = invoice.locations.find((l) => l.id === locId)?.name || 'Unknown';

				const befores = photosInGroup.filter((p) => p.type === 'before');
				const afters = photosInGroup.filter((p) => p.type === 'after');

				const maxLen = Math.max(befores.length, afters.length);
				for (let i = 0; i < maxLen; i++) {
					pairs.push({
						locationName: locName,
						angle,
						before: befores[i],
						after: afters[i]
					});
				}
			}
		}

		if (photoLayout === '1') {
			// 1 Photo per page
			for (const photo of sortedPhotos) {
				doc.addPage();
				const locName = invoice.locations.find((l) => l.id === photo.locationId)?.name || 'Unknown';
				doc.setFontSize(14);
				doc.text(`${locName} - ${photo.angle} - ${photo.type.toUpperCase()}`, 10, 20);
				const props = doc.getImageProperties(photo.dataUrl);
				const { w, h } = fitImage(props, 190, 250);
				doc.addImage(photo.dataUrl, props.fileType, 10, 25, w, h);
			}
		} else if (photoLayout === '2') {
			// 2 Photos per page (1 Pair Stacked)
			for (const pair of pairs) {
				doc.addPage();
				doc.setFontSize(14);
				doc.text(`${pair.locationName} - ${pair.angle}`, 10, 20);

				if (pair.before) {
					doc.setFontSize(12);
					doc.text('Before:', 10, 30);
					const props = doc.getImageProperties(pair.before.dataUrl);
					const { w, h } = fitImage(props, 190, 110);
					doc.addImage(pair.before.dataUrl, props.fileType, 10, 35, w, h);
				}

				if (pair.after) {
					doc.setFontSize(12);
					doc.text('After:', 10, 155);
					const props = doc.getImageProperties(pair.after.dataUrl);
					const { w, h } = fitImage(props, 190, 110);
					doc.addImage(pair.after.dataUrl, props.fileType, 10, 160, w, h);
				}
			}
		} else if (photoLayout === '6') {
			// 6 Photos per page (3 Pairs Side-by-Side)
			for (let i = 0; i < pairs.length; i += 3) {
				const chunk = pairs.slice(i, i + 3);
				doc.addPage();
				doc.setFontSize(14);
				doc.text('Photos', 10, 15);

				chunk.forEach((pair, index) => {
					const rowY = 25 + index * 90;
					doc.setFontSize(12);
					doc.text(`${pair.locationName} - ${pair.angle}`, 10, rowY);

					if (pair.before) {
						doc.text('Before', 10, rowY + 6);
						const props = doc.getImageProperties(pair.before.dataUrl);
						const { w, h } = fitImage(props, 90, 70);
						doc.addImage(pair.before.dataUrl, props.fileType, 10, rowY + 8, w, h);
					}

					if (pair.after) {
						doc.text('After', 110, rowY + 6);
						const props = doc.getImageProperties(pair.after.dataUrl);
						const { w, h } = fitImage(props, 90, 70);
						doc.addImage(pair.after.dataUrl, props.fileType, 110, rowY + 8, w, h);
					}
				});
			}
		}

		if (action === 'download') {
			doc.save(`${invoice.title}.pdf`);
		} else {
			if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
			const blob = doc.output('blob');
			pdfPreviewUrl = URL.createObjectURL(blob);
		}
	}
</script>

{#if !isLoaded}
	<p>Loading invoice...</p>
{:else if invoice}
	<div class="header-bar">
		<button onclick={() => goto(resolve('/'))}>&larr; Back</button>
		<input
			class="title-input"
			type="text"
			bind:value={invoice.title}
			placeholder="Invoice Record Title"
		/>
	</div>

	<!-- Invoice Document Details Configuration -->
	<div class="invoice-details-card">
		<h3>Invoice Details</h3>
		<div class="details-grid">
			<div class="details-col">
				<label>
					Contractor Name
					<input type="text" bind:value={invoice.contractorName} placeholder="E.g. ACME Mowing" />
				</label>
				<label>
					Contractor Address
					<textarea bind:value={invoice.contractorAddress} rows="3" placeholder="123 Main St..."
					></textarea>
				</label>
			</div>

			<div class="details-col">
				<label>
					Bill To Customer Name
					<input type="text" bind:value={invoice.customerName} placeholder="John Doe" />
				</label>
				<label>
					Bill To Address
					<textarea bind:value={invoice.customerAddress} rows="3" placeholder="456 Oak Ln..."
					></textarea>
				</label>
			</div>

			<div class="details-col">
				<label>
					Invoice Date
					<input type="date" bind:value={invoice.invoiceDate} />
				</label>
				<label>
					Invoice #
					<input type="text" bind:value={invoice.invoiceNumber} placeholder="INV-001" />
				</label>
			</div>
		</div>
	</div>

	<!-- PDF Output & Preview Controls -->
	<div class="pdf-controls">
		<label class="layout-label">
			<strong>Photo Layout:</strong>
			<select bind:value={photoLayout}>
				<option value="none">No Photos</option>
				<option value="1">1 per page</option>
				<option value="2">2 per page (Paired Before/After)</option>
				<option value="6">6 per page (3 Pairs)</option>
			</select>
		</label>
		<div class="export-actions">
			<button class="preview-btn" onclick={() => generatePDF('preview')}>Preview PDF</button>
			<button class="export-btn" onclick={() => generatePDF('download')}>Export PDF</button>
		</div>
	</div>

	<!-- Preview Viewer -->
	{#if pdfPreviewUrl}
		<div class="pdf-preview-container">
			<div class="preview-header">
				<h3>PDF Preview</h3>
				<button class="danger" onclick={() => (pdfPreviewUrl = null)}>Close Preview</button>
			</div>
			<iframe src={pdfPreviewUrl} title="PDF Preview" class="pdf-iframe"></iframe>
		</div>
	{/if}

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

				<textarea
					class="notes-textarea"
					bind:value={loc.notes}
					placeholder="Notes for this location..."
				></textarea>

				<!-- Photo Management -->
				<div class="photo-section">
					<h4>Photos</h4>

					<!-- Angles Configuration Manager -->
					<div class="angle-manager">
						<span>Manage Custom Angles:</span>
						{#each invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side'] as angle (angle)}
							<span class="angle-badge">
								{angle}
								<button type="button" class="delete-angle-btn" onclick={() => deleteAngle(angle)} title="Delete angle">&times;</button>
							</span>
						{/each}
						<form class="add-angle-form" onsubmit={addAngle}>
							<input type="text" name="angleName" placeholder="New Angle" />
							<button type="submit">Add</button>
						</form>
					</div>

					<input type="file" multiple accept="image/*" onchange={(e) => handleUpload(e, loc.id)} />

					<div class="photo-grid">
						{#each sortedPhotos.filter((p) => p.locationId === loc.id) as photo (photo.id)}
							<div class="photo-card">
								<img src={photo.dataUrl} alt="Lawn" />
								<div class="photo-controls">
									<!-- Custom Angle Selection Dropdown with "Other" option fallback -->
									<select
										value={(invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side']).includes(photo.angle) ? photo.angle : 'other'}
										onchange={(e) => {
											const val = (e.target as HTMLSelectElement).value;
											if (val !== 'other') {
												photo.angle = val;
												updatePhoto(photo);
											} else {
												photo.angle = 'Custom Angle';
												updatePhoto(photo);
											}
										}}
									>
										{#each invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side'] as angleOption (angleOption)}
											<option value={angleOption}>{angleOption}</option>
										{/each}
										<option value="other">Other...</option>
									</select>

									<!-- Display text input field when custom "Other" angle has been selected -->
									{#if !(invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side']).includes(photo.angle)}
										<input
											type="text"
											bind:value={photo.angle}
											onblur={() => updatePhoto(photo)}
											placeholder="Custom Angle Name"
										/>
									{/if}

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
		margin-bottom: 1.5rem;
	}
	.title-input {
		flex: 1;
		font-size: 1.5rem;
		font-weight: bold;
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
	}

	/* Document Details Grid Styles */
	.invoice-details-card {
		background: white;
		padding: 1.5rem;
		border-radius: 8px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		margin-bottom: 1.5rem;
	}
	.invoice-details-card h3 {
		margin-top: 0;
		margin-bottom: 1.5rem;
		color: #374151;
	}
	.details-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 1.5rem;
	}
	.details-col {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.details-col label {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		font-weight: 500;
		font-size: 0.9rem;
		color: #4b5563;
	}
	.details-col input,
	.details-col textarea {
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-family: inherit;
		font-size: 1rem;
	}

	/* Angle Manager Styles */
	.angle-manager {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1rem;
		padding: 0.75rem;
		background: #f9fafb;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
	}
	.angle-manager span {
		font-weight: 500;
		font-size: 0.9rem;
		color: #374151;
	}
	.angle-badge {
		background: #e0f2fe;
		color: #0369a1 !important;
		padding: 0.25rem 0.6rem;
		border-radius: 9999px;
		font-size: 0.85rem !important;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.delete-angle-btn {
		background: none;
		border: none;
		color: #ef4444;
		cursor: pointer;
		font-weight: bold;
		padding: 0;
		font-size: 1.1rem;
		line-height: 1;
	}
	.delete-angle-btn:hover {
		color: #b91c1c;
	}
	.add-angle-form {
		display: flex;
		gap: 0.25rem;
	}
	.add-angle-form input {
		padding: 0.25rem 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-size: 0.85rem;
	}
	.add-angle-form button {
		background-color: #3b82f6;
		color: white;
		border: none;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.add-angle-form button:hover {
		background-color: #2563eb;
	}

	/* Existing Styles */
	.pdf-controls {
		display: flex;
		justify-content: space-between;
		align-items: center;
		background: white;
		padding: 1rem;
		border-radius: 8px;
		margin-bottom: 2rem;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		flex-wrap: wrap;
		gap: 1rem;
	}
	.layout-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.export-actions {
		display: flex;
		gap: 0.5rem;
	}
	.preview-btn {
		background-color: #3b82f6;
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		cursor: pointer;
	}
	.export-btn {
		background-color: #8b5cf6;
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		cursor: pointer;
	}
	.pdf-preview-container {
		background: white;
		padding: 1rem;
		border-radius: 8px;
		margin-bottom: 2rem;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}
	.preview-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}
	.preview-header h3 {
		margin: 0;
	}
	.pdf-iframe {
		width: 100%;
		height: 600px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
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
	.loc-header input {
		flex: 1;
		font-size: 1.25rem;
		font-weight: 600;
		padding: 0.5rem;
	}
	.loc-grid {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: 1rem;
		align-items: end;
		margin-bottom: 1rem;
	}
	.loc-grid label {
		display: flex;
		flex-direction: column;
		font-size: 0.85rem;
		color: #4b5563;
		gap: 0.25rem;
	}
	.loc-grid input[type='text'],
	.loc-grid input[type='number'] {
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
	}
	.notes-textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		min-height: 60px;
	}
	.checkbox-label {
		display: flex;
		flex-direction: row !important;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		height: 100%;
		padding-bottom: 0.5rem;
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
	.photo-controls input,
	.photo-controls select {
		padding: 0.25rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
	}
	.meta {
		font-size: 0.75rem;
		color: #6b7280;
	}
	.danger {
		background-color: #ef4444;
		color: white;
		border: none;
		border-radius: 4px;
		padding: 0.5rem 1rem;
		cursor: pointer;
	}
	.add-loc-btn {
		margin-top: 2rem;
		width: 100%;
		padding: 1rem;
		font-size: 1.1rem;
		background-color: #10b981;
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
	}
</style>