import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export async function parseSTL(arrayBuffer: ArrayBuffer) {
  const loader = new STLLoader();
  const geometry = loader.parse(arrayBuffer);
  
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  
  const x = Number((box.max.x - box.min.x).toFixed(2));
  const y = Number((box.max.y - box.min.y).toFixed(2));
  const z = Number((box.max.z - box.min.z).toFixed(2));
  
  const { volume, area } = computeVolumeAndArea(geometry);
  
  return {
    x, y, z,
    volume: volume / 1000, // Convert mm³ to cm³
    surfaceArea: area / 100, // Convert mm² to cm²
  };
}

function computeVolumeAndArea(geometry: THREE.BufferGeometry): { volume: number; area: number } {
  let volume = 0;
  let area = 0;
  const position = geometry.attributes.position;
  
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  
  for (let i = 0; i < position.count; i += 3) {
    p1.fromBufferAttribute(position, i);
    p2.fromBufferAttribute(position, i + 1);
    p3.fromBufferAttribute(position, i + 2);
    
    // Triangle area (before p2 is mutated by cross below)
    e1.subVectors(p2, p1);
    e2.subVectors(p3, p1);
    area += e1.cross(e2).length() / 2;

    // Signed volume of tetrahedron
    volume += p1.dot(p2.cross(p3)) / 6.0;
  }
  
  return { volume: Math.abs(volume), area };
}
