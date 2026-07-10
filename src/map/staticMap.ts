import StaticMaps from 'staticmaps';
import { config } from '../config.js';

export async function renderMap(lat: number, lon: number): Promise<Buffer> {
  const map = new StaticMaps({
    width: config.map.width,
    height: config.map.height,
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileRequestHeader: { 'User-Agent': 'cr7jet-tracker/1.0' }, // OSM tile policy
  });
  // ponytail: circle instead of a marker icon — no image asset to bundle
  map.addCircle({ coord: [lon, lat], radius: 900, color: '#c1121f', fill: '#c1121fbb', width: 3 });
  await map.render([lon, lat], config.map.zoom);
  return map.image.buffer('image/png');
}
