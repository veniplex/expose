import companiesData from './data/companies.json';
import personalitiesData from './data/personalities.json';
import politiciansData from './data/politicians.json';
import governmentsData from './data/governments.json';
import connectionsData from './data/connections.json';

export const companies = companiesData;
export const personalities = personalitiesData;
export const politicians = politiciansData;
export const governments = governmentsData;
export const connections = connectionsData;

export function getAllNodes() {
    return [
        ...companies.map(c => ({ ...c, type: 'company' })),
        ...personalities.map(p => ({ ...p, type: 'personality' })),
        ...politicians.map(p => ({ ...p, type: 'politician' })),
        ...governments.map(g => ({ ...g, type: 'government' }))
    ];
}

export function getLinks() {
    return connections.map(conn => {
        const sourceNode = getAllNodes().find(n => n.id === conn.source);
        const targetNode = getAllNodes().find(n => n.id === conn.target);
        return { ...conn, source: sourceNode, target: targetNode };
    }).filter(l => l.source && l.target);
}
