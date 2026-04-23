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
  
  const volume = computeVolume(geometry);
  
  return {
    x, y, z,
    volume: volume / 1000 // Convert mm³ to cm³
  };
}

function computeVolume(geometry: THREE.BufferGeometry): number {
  let volume = 0;
  const position = geometry.attributes.position;
  
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  
  for (let i = 0; i < position.count; i += 3) {
    p1.fromBufferAttribute(position, i);
    p2.fromBufferAttribute(position, i + 1);
    p3.fromBufferAttribute(position, i + 2);
    
    // Signed volume of tetrahedron
    volume += p1.dot(p2.cross(p3)) / 6.0;
  }
  
  return Math.abs(volume);
}
