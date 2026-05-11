import type { PageLoad } from './$types';

// Exclude this dynamic route from the layout's `prerender = true` enforcement
export const prerender = false;

export const load: PageLoad = ({ params }) => {
	return { id: Number(params.id) };
};
