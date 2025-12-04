export const companies = [
    { id: 'c1', name: 'TechGlobal', industry: 'Technology', lat: 37.7749, lng: -122.4194, description: 'Leading provider of AI solutions.' }, // San Francisco
    { id: 'c2', name: 'EuroFinance', industry: 'Finance', lat: 51.5074, lng: -0.1278, description: 'Major European banking institution.' }, // London
    { id: 'c3', name: 'AsiaMotors', industry: 'Automotive', lat: 35.6895, lng: 139.6917, description: 'Innovative electric vehicle manufacturer.' }, // Tokyo
    { id: 'c4', name: 'NordicEnergy', industry: 'Energy', lat: 59.3293, lng: 18.0686, description: 'Sustainable energy solutions.' }, // Stockholm
    { id: 'c5', name: 'LatAmRetail', industry: 'Retail', lat: -23.5505, lng: -46.6333, description: 'Largest retail chain in South America.' }, // Sao Paulo
    { id: 'c6', name: 'OzMining', industry: 'Mining', lat: -33.8688, lng: 151.2093, description: 'Global mining operations.' }, // Sydney
    { id: 'c7', name: 'AfriCom', industry: 'Telecommunications', lat: -1.2921, lng: 36.8219, description: 'Connecting the continent.' }, // Nairobi
    { id: 'c8', name: 'CanHealth', industry: 'Healthcare', lat: 43.6532, lng: -79.3832, description: 'Advanced medical research.' }, // Toronto
];

export const personalities = [
    { id: 'p1', name: 'Alice Chen', role: 'CEO', lat: 34.0522, lng: -118.2437, description: 'Visionary leader in tech.' }, // Los Angeles
    { id: 'p2', name: 'Bob Smith', role: 'Investor', lat: 40.7128, lng: -74.0060, description: 'Prominent venture capitalist.' }, // New York
    { id: 'p3', name: 'Charlie Kim', role: 'Engineer', lat: 37.5665, lng: 126.9780, description: 'Chief Architect of new EV platform.' }, // Seoul
    { id: 'p4', name: 'Diana Prince', role: 'Activist', lat: 48.8566, lng: 2.3522, description: 'Environmental advocate.' }, // Paris
    { id: 'p5', name: 'Evan Wright', role: 'Journalist', lat: 52.5200, lng: 13.4050, description: 'Tech investigative journalist.' }, // Berlin
    { id: 'p6', name: 'Fiona Gallagher', role: 'Designer', lat: 41.9028, lng: 12.4964, description: 'Award-winning product designer.' }, // Rome
];

export const connections = [
    { source: 'c1', target: 'p1', type: 'Founder' },
    { source: 'c1', target: 'p2', type: 'Investor' },
    { source: 'c2', target: 'p2', type: 'Board Member' },
    { source: 'c3', target: 'p3', type: 'Employee' },
    { source: 'c4', target: 'p4', type: 'Advisor' },
    { source: 'c1', target: 'c3', type: 'Partnership' },
    { source: 'c5', target: 'c2', type: 'Subsidiary' },
    { source: 'p5', target: 'c1', type: 'Reported On' },
    { source: 'p6', target: 'c3', type: 'Consultant' },
    { source: 'c6', target: 'c7', type: 'Supplier' },
    { source: 'c8', target: 'p1', type: 'Philanthropy' },
];

export function getAllNodes() {
    return [
        ...companies.map(c => ({ ...c, type: 'company' })),
        ...personalities.map(p => ({ ...p, type: 'personality' }))
    ];
}

export function getLinks() {
    return connections.map(conn => {
        const sourceNode = getAllNodes().find(n => n.id === conn.source);
        const targetNode = getAllNodes().find(n => n.id === conn.target);
        return { ...conn, source: sourceNode, target: targetNode };
    }).filter(l => l.source && l.target);
}
