import Dexie, { type Table } from 'dexie';

export interface Location {
	id: string;
	name: string;
	service: string;
	cost: number;
	serviced: boolean;
	notes: string;
	angles?: string[]; // Added: Custom angles mapped per location
}

export interface Invoice {
	id?: number;
	title: string;
	createdAt: number;
	locations: Location[];
	angles?: string[]; // Preserved for legacy migrations
}

export interface Photo {
	id?: number;
	invoiceId: number;
	locationId: string;
	angle: string;
	type: 'before' | 'after';
	dataUrl: string;
	timestamp: number;
}

export class LawnDB extends Dexie {
	invoices!: Table<Invoice, number>;
	photos!: Table<Photo, number>;

	constructor() {
		super('LawnDB');
		this.version(1).stores({
			invoices: '++id, createdAt',
			photos: '++id, invoiceId, locationId, angle, type'
		});
	}
}

export const db = new LawnDB();