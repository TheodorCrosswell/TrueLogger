--- START OF FILE Paste July 10, 2026 - 11:47AM ---

<script lang="ts">
	import { db, type Invoice, type Photo } from '$lib/db';
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import jsPDF from 'jspdf';
	import autoTable from 'jspdf-autotable';
	import exifr from 'exifr'; 
	import imageCompression from 'browser-image-compression';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let invoice = $state<Invoice | undefined>(undefined);
	let photos = $state<Photo[]>([]);
	let isLoaded = $state(false);

	// Collapsible Locations State
	let expandedLocations = $state<Record<string, boolean>>({});

	// PDF Layout State
	let photoLayout = $state<'none' | '1' | '2' | '6'>('none');
	let pdfPreviewUrl = $state<string | null>(null);
	let showTimestampsOnPdf = $state(true); 

	// Sort State tracking
	let photoErrors = $state<Record<number, boolean>>({});
	let sortMessages = $state<Record<string, {text: string, type: 'success' | 'error'}>>({});

	// CV Clustering State
	let isClustering = $state(false);
	let showGroupingModal = $state(false);
	let angleGroups = $state<{ photos: Photo[]; selectedAngle: string; customAngle?: string }[]>([]);
	let clusteringLocationId = $state<string | null>(null);

	// Auto-Detect Clustering Adjustable Settings
	let similarityThreshold = $state(76); 
	let resolutionScale = $state(8); 

	onMount(async () => {
		invoice = await db.invoices.get(data.id);
		
		if (!invoice) {
			goto(resolve('/'));
			return; 
		}

		const globalAngles = invoice.angles || ['Front', 'Back', 'Left Side', 'Right Side'];
		invoice.locations = invoice.locations.map(loc => {
			if (!loc.angles) {
				loc.angles = [...globalAngles];
			}
			return loc;
		});
		
		photos = await db.photos.where('invoiceId').equals(data.id).toArray();
		isLoaded = true;
	});
	
	onDestroy(() => {
		if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
	});

	$effect(() => {
		if (invoice && isLoaded) {
			const snap = $state.snapshot(invoice);
			db.invoices.put(snap);
		}
	});

	// --- LIGHTWEIGHT COMPUTER VISION (dHash Algorithm) ---
	function getDHash(dataUrl: string, scale: number = 8): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width = scale + 1;
				canvas.height = scale;
				const ctx = canvas.getContext('2d');
				if (!ctx) return resolve('0'.repeat(scale * scale));
				
				ctx.drawImage(img, 0, 0, scale + 1, scale);
				const data = ctx.getImageData(0, 0, scale + 1, scale).data;
				let hash = '';
				
				for (let y = 0; y < scale; y++) {
					for (let x = 0; x < scale; x++) {
						const idx1 = (y * (scale + 1) + x) * 4;
						const idx2 = (y * (scale + 1) + (x + 1)) * 4;
						// Grayscale conversion
						const g1 = data[idx1] * 0.299 + data[idx1 + 1] * 0.587 + data[idx1 + 2] * 0.114;
						const g2 = data[idx2] * 0.299 + data[idx2 + 1] * 0.587 + data[idx2 + 2] * 0.114;
						hash += g1 > g2 ? '1' : '0';
					}
				}
				resolve(hash);
			};
			img.onerror = reject;
			img.src = dataUrl;
		});
	}

	function hammingDistance(hash1: string, hash2: string): number {
		let dist = 0;
		for (let i = 0; i < Math.min(hash1.length, hash2.length); i++) {
			if (hash1[i] !== hash2[i]) dist++;
		}
		return dist + Math.abs(hash1.length - hash2.length);
	}

	async function autoDetectAngles(locationId: string) {
		const locPhotos = photos.filter((p) => p.locationId === locationId);
		if (locPhotos.length === 0) return;

		isClustering = true;
		clusteringLocationId = locationId;

		try {
			const currentScale = Number(resolutionScale);
			// 1. Generate hashes for all photos in the background based on resolution scale
			const photoHashes = await Promise.all(
				locPhotos.map(async (photo) => ({
					photo,
					hash: await getDHash(photo.dataUrl, currentScale)
				}))
			);

			// 2. Cluster them by visual similarity
			const clusters: { baseHash: string; photos: Photo[] }[] = [];
			
			// Total bits will be scale squared (e.g. 8x8 = 64 bits)
			const hashLength = currentScale * currentScale;
			// Allowable differing bits based on similarity percentage
			const THRESHOLD = Math.floor(hashLength * (1 - (Number(similarityThreshold) / 100)));

			for (const item of photoHashes) {
				let matchedCluster = null;
				for (const cluster of clusters) {
					if (hammingDistance(item.hash, cluster.baseHash) <= THRESHOLD) {
						matchedCluster = cluster;
						break;
					}
				}
				if (matchedCluster) {
					matchedCluster.photos.push(item.photo);
				} else {
					clusters.push({ baseHash: item.hash, photos: [item.photo] });
				}
			}

			// 3. Prepare State for the Modal
			const locationAngles = invoice?.locations.find((l) => l.id === locationId)?.angles || ['Front', 'Back', 'Left Side', 'Right Side'];

			angleGroups = clusters.map((c) => {
				const existingAngles = c.photos.map(p => p.angle).filter(a => a && a !== 'Unknown');
				const predominant = existingAngles.length > 0 ? existingAngles[0] : 'Unknown';
				
				let selectedAngle = predominant;
				let customAngle = '';
				
				if (predominant !== 'Unknown' && !locationAngles.includes(predominant)) {
					selectedAngle = 'other';
					customAngle = predominant;
				}

				return {
					photos: c.photos,
					selectedAngle,
					customAngle
				};
			});

			showGroupingModal = true;
		} catch (err) {
			console.error('Error clustering photos:', err);
		} finally {
			isClustering = false;
		}
	}

	function closeModal() {
		showGroupingModal = false;
		clusteringLocationId = null;
		angleGroups = [];
	}

	async function saveAssignments() {
		if (!clusteringLocationId) return;

		let needsUpdate = false;
		for (const group of angleGroups) {
			const finalAngle = group.selectedAngle === 'other' ? (group.customAngle || 'Custom Angle') : group.selectedAngle;

			if (finalAngle !== 'Unknown') {
				for (const photo of group.photos) {
					photo.angle = finalAngle;
					await db.photos.put($state.snapshot(photo));

					const idx = photos.findIndex((p) => p.id === photo.id);
					if (idx !== -1) photos[idx] = photo;
					needsUpdate = true;
				}
			}
		}

		if (needsUpdate) {
			// Trigger the existing Auto-Sort sequence right after applying to group Before & Afters
			await sortAndAssign(clusteringLocationId);
		}

		closeModal();
	}
	// -------------------------------------------------------------

	async function sortAndAssign(locationId: string) {
		const locPhotos = photos.filter(p => p.locationId === locationId);
		
		const grouped: Record<string, Photo[]> = {};
		for (const p of locPhotos) {
			const angle = p.angle || 'Unknown';
			if (!grouped[angle]) grouped[angle] = [];
			grouped[angle].push(p);
		}

		let errorCount = 0;
		const photosToUpdate: Photo[] = [];

		for (const p of locPhotos) {
			if (p.id) delete photoErrors[p.id];
		}

		for (const group of Object.values(grouped)) {
			if (group.length === 2) {
				group.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
				
				if (group[0].type !== 'before') {
					group[0].type = 'before';
					photosToUpdate.push(group[0]);
				}
				if (group[1].type !== 'after') {
					group[1].type = 'after';
					photosToUpdate.push(group[1]);
				}
			} else {
				group.forEach(p => {
					if (p.id) {
						photoErrors[p.id] = true;
						errorCount++;
					}
				});
			}
		}

		if (photosToUpdate.length > 0) {
			for (const p of photosToUpdate) {
				await db.photos.put($state.snapshot(p));
			}
		}

		if (errorCount > 0) {
			sortMessages[locationId] = { text: `Found ${errorCount} error(s)`, type: 'error' };
		} else {
			sortMessages[locationId] = { text: 'Sorted successfully', type: 'success' };
		}

		photos = [...photos].sort((a, b) => {
			const angleA = (a.angle || '').toLowerCase();
			const angleB = (b.angle || '').toLowerCase();
			if (angleA < angleB) return -1;
			if (angleA > angleB) return 1;
			if (a.type === 'before' && b.type === 'after') return -1;
			if (a.type === 'after' && b.type === 'before') return 1;
			return (a.timestamp || 0) - (b.timestamp || 0);
		});
	}

	function toggleLocation(id: string) {
		expandedLocations[id] = !expandedLocations[id];
	}

	function addLocation() {
		if (!invoice) return;
		const newId = crypto.randomUUID();
		invoice.locations = [
			...invoice.locations,
			{
				id: newId,
				name: 'New Location',
				service: 'Mowing',
				cost: 0,
				serviced: false,
				notes: '',
				angles: ['Front', 'Back', 'Left Side', 'Right Side']
			}
		];
		expandedLocations[newId] = true;
	}

	async function removeLocation(id: string) {
		if (!invoice) return;
		
		invoice.locations = invoice.locations.filter((l) => l.id !== id);
		delete expandedLocations[id];

		const photosToDelete = photos.filter((p) => p.locationId === id);
		for (const photo of photosToDelete) {
			if (photo.id) {
				await db.photos.delete(photo.id);
			}
		}
		photos = photos.filter((p) => p.locationId !== id);
	}

	function addAngle(e: SubmitEvent, locId: string) {
		e.preventDefault();
		if (!invoice) return;
		const form = e.currentTarget as HTMLFormElement;
		const input = form.querySelector('input[name="angleName"]') as HTMLInputElement;
		const trimmed = input.value.trim();
		if (!trimmed) return;

		const loc = invoice.locations.find((l) => l.id === locId);
		if (!loc) return;

		const currentAngles = loc.angles || ['Front', 'Back', 'Left Side', 'Right Side'];
		if (!currentAngles.includes(trimmed)) {
			loc.angles = [...currentAngles, trimmed];
		}
		input.value = '';
	}

	function deleteAngle(locId: string, angleToDelete: string) {
		if (!invoice) return;
		const loc = invoice.locations.find((l) => l.id === locId);
		if (!loc) return;

		const currentAngles = loc.angles || ['Front', 'Back', 'Left Side', 'Right Side'];
		loc.angles = currentAngles.filter((a) => a !== angleToDelete);
	}

	async function handleUpload(event: Event, locationId: string) {
		const input = event.target as HTMLInputElement;
		if (!input.files || !invoice) return;

		for (const file of input.files) {
			let timestamp = file.lastModified || Date.now();
			
			try {
				const exifData = await exifr.parse(file, { pick: ['DateTimeOriginal'] });
				if (exifData?.DateTimeOriginal) {
					timestamp = new Date(exifData.DateTimeOriginal).getTime();
				}
			} catch (err) {
				console.warn('Could not read EXIF data', err);
			}

			try {
				const options = {
					maxSizeMB: 0.15,
					maxWidthOrHeight: 1024,
					initialQuality: 0.7,
					useWebWorker: true,
					fileType: 'image/jpeg'
				};
				const compressedFile = await imageCompression(file, options);
				const dataUrl = await fileToDataUrl(compressedFile);

				const newPhoto: Photo = {
					invoiceId: invoice.id!,
					locationId,
					angle: 'Unknown',
					type: 'other',
					dataUrl,
					timestamp
				};
				const photoId = await db.photos.add(newPhoto);
				photos = [...photos, { ...newPhoto, id: photoId }];
				
				delete sortMessages[locationId];
			} catch (error) {
				console.error('Error compressing image:', error);
			}
		}
		input.value = ''; 
	}

	function fileToDataUrl(file: File | Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function updatePhoto(photo: Photo) {
		await db.photos.put($state.snapshot(photo));
		photos = photos.map((p) => (p.id === photo.id ? photo : p));
		
		if (photo.id && photoErrors[photo.id]) {
			delete photoErrors[photo.id];
		}
		if (photo.locationId) {
			delete sortMessages[photo.locationId];
		}
	}

	async function deletePhoto(id: number) {
		const photoToDelete = photos.find(p => p.id === id);
		await db.photos.delete(id);
		photos = photos.filter((p) => p.id !== id);
		
		if (photoErrors[id]) delete photoErrors[id];
		if (photoToDelete?.locationId) delete sortMessages[photoToDelete.locationId];
	}

	interface jsPDFWithAutoTable extends jsPDF {
		lastAutoTable?: {
			finalY: number;
		};
	}
	
	function generatePDF(action: 'download' | 'preview') {
		if (!invoice) return;
		const doc = new jsPDF({ compress: true });
		const pageWidth = doc.internal.pageSize.width;
		const pageHeight = doc.internal.pageSize.height;

		// --- INVOICE HEADER ---
		doc.setFontSize(20);
		doc.text(invoice.contractorName || 'Contractor Name', 14, 22);
		doc.setFontSize(24);
		doc.text('INVOICE', pageWidth - 14, 22, { align: 'right' });
		doc.setFontSize(10);
		if (invoice.contractorAddress) {
			const splitContractorAddress = doc.splitTextToSize(invoice.contractorAddress, 80);
			doc.text(splitContractorAddress, 14, 30);
		}
		doc.text(`Date: ${invoice.invoiceDate || ''}`, pageWidth - 14, 30, { align: 'right' });
		doc.text(`Invoice #: ${invoice.invoiceNumber || ''}`, pageWidth - 14, 35, { align: 'right' });

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
			`$${(loc.serviced ? loc.cost : 0).toFixed(2)}`
		]);

		const total = invoice.locations.filter((l) => l.serviced).reduce((sum, l) => sum + l.cost, 0);
		tableData.push(['', '', '', 'GRAND TOTAL:', `$${total.toFixed(2)}`]);

		autoTable(doc, {
			startY: 85,
			head: [['Location', 'Service', 'Serviced', 'Notes', 'Cost']],
			body: tableData,
			footStyles: { fillColor: [200, 200, 200] },
			willDrawCell: (data) => {
				if (data.row.index === tableData.length - 1) {
					data.cell.styles.fontStyle = 'bold';
				}
			}
		});

		let finalY = (doc as jsPDFWithAutoTable).lastAutoTable?.finalY || 85;

		if (finalY > pageHeight - 40) {
			doc.addPage();
			finalY = 20; 
		}

		doc.setFontSize(12);
		doc.text(
			`Make all checks payable to ${invoice.contractorName || 'Contractor'}`,
			14,
			finalY + 15
		);
		doc.setFontSize(14);
		doc.text('THANK YOU FOR YOUR BUSINESS', pageWidth / 2, pageHeight - 15, { align: 'center' });

		// --- PHOTOS LOGIC ---
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

		if (photoLayout !== 'none') {
			for (const loc of invoice.locations) {
				const locPhotos = [...photos]
					.filter((p) => p.locationId === loc.id)
					.sort((a, b) => {
						const angleA = (a.angle || '').toLowerCase();
						const angleB = (b.angle || '').toLowerCase();
						if (angleA < angleB) return -1;
						if (angleA > angleB) return 1;
						if (a.type === 'before' && b.type === 'after') return -1;
						if (a.type === 'after' && b.type === 'before') return 1;
						return (a.timestamp || 0) - (b.timestamp || 0);
					});

				if (locPhotos.length === 0) continue;

				if (photoLayout === '1') {
					for (const photo of locPhotos) {
						doc.addPage();
						doc.setFontSize(14);
						const typeStr = (photo.type || 'other').toUpperCase();
						const angleStr = photo.angle || 'Unknown';
						doc.text(`${loc.name} - ${angleStr} - ${typeStr}`, 10, 20);
						
						if (showTimestampsOnPdf) {
							doc.setFontSize(10);
							const timeStr = photo.timestamp ? new Date(photo.timestamp).toLocaleString() : 'Unknown';
							doc.text(`Taken: ${timeStr}`, 10, 26);
						}
						
						const props = doc.getImageProperties(photo.dataUrl);
						const { w, h } = fitImage(props, 190, 245);
						doc.addImage(photo.dataUrl, props.fileType, 10, 30, w, h, undefined, 'FAST');
					}
				} else if (photoLayout === '2' || photoLayout === '6') {
					const pairs: { locationName: string; angle: string; photo1?: Photo; photo2?: Photo }[] = [];
					const grouped: Record<string, Photo[]> = {};

					for (const p of locPhotos) {
						const angle = p.angle || 'Unknown';
						if (!grouped[angle]) grouped[angle] = [];
						grouped[angle].push(p);
					}

					const orderedAngles = Array.from(new Set(locPhotos.map(p => p.angle || 'Unknown')));

					for (const angle of orderedAngles) {
						const photosInGroup = grouped[angle];
						const befores = photosInGroup.filter((p) => p.type === 'before');
						const afters = photosInGroup.filter((p) => p.type === 'after');
						const others = photosInGroup.filter((p) => p.type !== 'before' && p.type !== 'after');

						const maxLen = Math.max(befores.length, afters.length);
						
						for (let i = 0; i < maxLen; i++) {
							let p1: Photo | undefined = befores[i];
							let p2: Photo | undefined = afters[i];
							
							if (!p1 && others.length > 0) p1 = others.shift();
							if (!p2 && others.length > 0) p2 = others.shift();

							pairs.push({ locationName: loc.name, angle, photo1: p1, photo2: p2 });
						}

						for (let i = 0; i < others.length; i += 2) {
							pairs.push({
								locationName: loc.name,
								angle,
								photo1: others[i],
								photo2: others[i + 1]
							});
						}
					}

					const chunkSize = photoLayout === '2' ? 1 : 3;
					
					for (let i = 0; i < pairs.length; i += chunkSize) {
						const chunk = pairs.slice(i, i + chunkSize);
						doc.addPage();
						
						if (photoLayout === '2') {
							const pair = chunk[0];
							doc.setFontSize(14);
							doc.text(`${pair.locationName} - ${pair.angle}`, 10, 20);

							if (pair.photo1) {
								doc.setFontSize(12);
								const typeStr = (pair.photo1.type || 'other').charAt(0).toUpperCase() + (pair.photo1.type || 'other').slice(1);
								const timeStr = pair.photo1.timestamp ? new Date(pair.photo1.timestamp).toLocaleString() : 'Unknown';
								const label = showTimestampsOnPdf ? `${typeStr}: ${timeStr}` : typeStr;
								doc.text(label, 10, 30);
								
								const props = doc.getImageProperties(pair.photo1.dataUrl);
								const { w, h } = fitImage(props, 190, 110);
								doc.addImage(pair.photo1.dataUrl, props.fileType, 10, 35, w, h, undefined, 'FAST');
							}

							if (pair.photo2) {
								doc.setFontSize(12);
								const typeStr = (pair.photo2.type || 'other').charAt(0).toUpperCase() + (pair.photo2.type || 'other').slice(1);
								const timeStr = pair.photo2.timestamp ? new Date(pair.photo2.timestamp).toLocaleString() : 'Unknown';
								const label = showTimestampsOnPdf ? `${typeStr}: ${timeStr}` : typeStr;
								doc.text(label, 10, 155);

								const props = doc.getImageProperties(pair.photo2.dataUrl);
								const { w, h } = fitImage(props, 190, 110);
								doc.addImage(pair.photo2.dataUrl, props.fileType, 10, 160, w, h, undefined, 'FAST');
							}
						} else if (photoLayout === '6') {
							doc.setFontSize(14);
							doc.text(`Photos - ${loc.name}`, 10, 15);

							chunk.forEach((pair, index) => {
								const rowY = 25 + index * 90;
								doc.setFontSize(12);
								doc.text(`${pair.locationName} - ${pair.angle}`, 10, rowY);

								if (pair.photo1) {
									doc.setFontSize(10);
									const typeStr = (pair.photo1.type || 'other').charAt(0).toUpperCase() + (pair.photo1.type || 'other').slice(1);
									const timeStr = pair.photo1.timestamp ? new Date(pair.photo1.timestamp).toLocaleString() : 'Unknown';
									const label = showTimestampsOnPdf ? `${typeStr} - ${timeStr}` : typeStr;
									doc.text(label, 10, rowY + 6);

									const props = doc.getImageProperties(pair.photo1.dataUrl);
									const { w, h } = fitImage(props, 90, 70);
									doc.addImage(pair.photo1.dataUrl, props.fileType, 10, rowY + 8, w, h, undefined, 'FAST');
								}

								if (pair.photo2) {
									doc.setFontSize(10);
									const typeStr = (pair.photo2.type || 'other').charAt(0).toUpperCase() + (pair.photo2.type || 'other').slice(1);
									const timeStr = pair.photo2.timestamp ? new Date(pair.photo2.timestamp).toLocaleString() : 'Unknown';
									const label = showTimestampsOnPdf ? `${typeStr} - ${timeStr}` : typeStr;
									doc.text(label, 110, rowY + 6);

									const props = doc.getImageProperties(pair.photo2.dataUrl);
									const { w, h } = fitImage(props, 90, 70);
									doc.addImage(pair.photo2.dataUrl, props.fileType, 110, rowY + 8, w, h, undefined, 'FAST');
								}
							});
						}
					}
				}
			}
		}

		// --- PAGE NUMBERS ---
		const totalPages = doc.getNumberOfPages();
		for (let i = 1; i <= totalPages; i++) {
			doc.setPage(i);
			doc.setFontSize(10);
			doc.setTextColor(150); 
			doc.text(`Page ${i} of ${totalPages}`, pageWidth - 14, pageHeight - 10, { align: 'right' });
		}
		doc.setTextColor(0); 

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
		
		<label class="checkbox-label" style="font-weight: 500;">
			<input type="checkbox" bind:checked={showTimestampsOnPdf} />
			Show Timestamps on PDF
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
				<div class="loc-header {expandedLocations[loc.id] ? 'expanded' : ''}">
					<button 
						class="toggle-btn" 
						aria-label="Toggle location" 
						onclick={() => toggleLocation(loc.id)}
					>
						{expandedLocations[loc.id] ? '▼' : '▶'}
					</button>
					<input type="text" bind:value={loc.name} placeholder="Location Name" />
					<button class="danger" onclick={() => removeLocation(loc.id)}>X</button>
				</div>

				{#if expandedLocations[loc.id]}
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
						
						<div class="photo-section-header">
							<div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
								<h4>Photos</h4>

								<div class="detection-settings">
									<label class="setting-label">
										Detail Level:
										<select bind:value={resolutionScale}>
											<option value={8}>Low (8x8)</option>
											<option value={16}>Medium (16x16)</option>
											<option value={32}>High (32x32)</option>
										</select>
									</label>
									<label class="setting-label">
										Similarity Threshold: {similarityThreshold}%
										<input type="range" min="50" max="100" bind:value={similarityThreshold} />
									</label>
								</div>
							</div>

							<div class="sort-controls">
								{#if sortMessages[loc.id]}
									<span class="sort-msg {sortMessages[loc.id].type}">
										{sortMessages[loc.id].text}
									</span>
								{/if}
								<button 
									type="button" 
									class="detect-btn" 
									onclick={() => autoDetectAngles(loc.id)} 
									disabled={isClustering}
								>
									{isClustering && clusteringLocationId === loc.id ? 'Detecting...' : 'Auto-Detect Angles'}
								</button>
								<button type="button" class="sort-btn" onclick={() => sortAndAssign(loc.id)}>
									Sort & Auto-Assign
								</button>
							</div>
						</div>

						<!-- Angles Configuration Manager -->
						<div class="angle-manager">
							<span>Manage Custom Angles:</span>
							{#each loc.angles || ['Front', 'Back', 'Left Side', 'Right Side'] as angle (angle)}
								<span class="angle-badge">
									{angle}
									<button type="button" class="delete-angle-btn" onclick={() => deleteAngle(loc.id, angle)} title="Delete angle">&times;</button>
								</span>
							{/each}
							<form class="add-angle-form" onsubmit={(e) => addAngle(e, loc.id)}>
								<input type="text" name="angleName" placeholder="New Angle" />
								<button type="submit">Add</button>
							</form>
						</div>

						<input type="file" multiple accept="image/*" onchange={(e) => handleUpload(e, loc.id)} />

						<div class="photo-grid">
							{#each photos.filter((p) => p.locationId === loc.id) as photo (photo.id)}
								<div class="photo-card {photoErrors[photo.id!] ? 'error-highlight' : ''}">
									<img src={photo.dataUrl} alt="Lawn" />
									<div class="photo-controls">
										<select
											value={photo.angle === 'Unknown' ? 'Unknown' : ((loc.angles || ['Front', 'Back', 'Left Side', 'Right Side']).includes(photo.angle) ? photo.angle : 'other')}
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
											<option value="Unknown">Unknown Angle</option>
											{#each loc.angles || ['Front', 'Back', 'Left Side', 'Right Side'] as angleOption (angleOption)}
												<option value={angleOption}>{angleOption}</option>
											{/each}
											<option value="other">Other...</option>
										</select>

										{#if photo.angle !== 'Unknown' && !(loc.angles || ['Front', 'Back', 'Left Side', 'Right Side']).includes(photo.angle)}
											<input
												type="text"
												bind:value={photo.angle}
												onblur={() => updatePhoto(photo)}
												placeholder="Custom Angle Name"
											/>
										{/if}

										<select bind:value={photo.type} onchange={() => updatePhoto(photo)}>
											<option value="other">Other</option>
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
				{/if}
			</div>
		{/each}
	</div>

	<button class="add-loc-btn" onclick={addLocation}>+ Add Location</button>

	<!-- Auto-Detect Angles Modal -->
	{#if showGroupingModal && clusteringLocationId}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-overlay" onclick={closeModal}>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal-content" onclick={(e) => e.stopPropagation()}>
				<div class="modal-header">
					<h3>Assign Auto-Detected Angles</h3>
					<button class="danger" style="padding: 0.25rem 0.5rem" onclick={closeModal}>&times;</button>
				</div>
				<div class="modal-body">
					{#each angleGroups as group, i (i)}
						<div class="cluster-group">
							<div class="cluster-header">
								<strong>Group {i + 1}</strong> <span style="color:#6b7280; font-size: 0.9rem;">({group.photos.length} photos)</span>
								
								<select bind:value={group.selectedAngle}>
									<option value="Unknown">Select Angle...</option>
										{#each (invoice.locations.find(l => l.id === clusteringLocationId)?.angles || ['Front', 'Back', 'Left Side', 'Right Side']) as angleOption (angleOption)}
											<option value={angleOption}>{angleOption}</option>
										{/each}
									<option value="other">Other...</option>
								</select>

								{#if group.selectedAngle === 'other'}
									<input type="text" bind:value={group.customAngle} placeholder="Custom Angle Name" />
								{/if}
							</div>
							<div class="cluster-thumbnails">
								{#each group.photos as photo (photo.id)}
									<img src={photo.dataUrl} alt="Thumbnail" />
								{/each}
							</div>
						</div>
					{/each}
				</div>
				<div class="modal-footer">
					<button class="cancel-btn" onclick={closeModal}>Cancel</button>
					<button class="save-btn" onclick={saveAssignments}>Save Assignments</button>
				</div>
			</div>
		</div>
	{/if}
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
		align-items: center;
	}
	.loc-header.expanded {
		margin-bottom: 1rem;
	}
	.toggle-btn {
		background: none;
		border: none;
		font-size: 1.1rem;
		cursor: pointer;
		color: #4b5563;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background-color 0.2s, color 0.2s;
	}
	.toggle-btn:hover {
		background-color: #f3f4f6;
		color: #111827;
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
	.photo-section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.photo-section-header h4 {
		margin: 0;
	}

	/* Clustering Adjustable Settings CSS */
	.detection-settings {
		display: flex;
		gap: 1.25rem;
		align-items: center;
		background: #f9fafb;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		border: 1px solid #e5e7eb;
		font-size: 0.85rem;
		flex-wrap: wrap;
	}
	.setting-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: #374151;
		font-weight: 500;
	}
	.setting-label select {
		padding: 0.25rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-size: 0.85rem;
	}
	.setting-label input[type="range"] {
		width: 100px;
	}

	.sort-controls {
		display: flex;
		align-items: center;
		gap: 1rem;
	}
	.detect-btn {
		background-color: #f59e0b;
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.detect-btn:hover:not(:disabled) {
		background-color: #d97706;
	}
	.detect-btn:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}
	.sort-btn {
		background-color: #3b82f6;
		color: white;
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.sort-btn:hover {
		background-color: #2563eb;
	}
	.sort-msg.success {
		color: #10b981;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.sort-msg.error {
		color: #ef4444;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.error-highlight {
		border: 2px solid #ef4444 !important;
		box-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
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

	/* Clustering Modal Styles */
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
		gap: 1.5rem;
	}
	.cluster-group {
		border: 1px solid #d1d5db;
		border-radius: 8px;
		padding: 1rem;
		background: #f9fafb;
	}
	.cluster-header {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}
	.cluster-header select, .cluster-header input {
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-size: 0.9rem;
	}
	.cluster-thumbnails {
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.cluster-thumbnails img {
		width: 100px;
		height: 100px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid #e5e7eb;
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
		background: #10b981;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-weight: 500;
	}
	.save-btn:hover {
		background: #059669;
	}
</style>