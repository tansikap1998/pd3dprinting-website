// เชื่อมกับระบบคิวพิมพ์ (apps/print-queue) ซึ่งจะแจ้งเตือนเข้ากลุ่ม LINE ของทีมให้เอง
// ใช้ได้เฉพาะฝั่ง server เท่านั้น เพราะมี API key

const BASE = (process.env.PRINT_QUEUE_URL || '').replace(/\/+$/, '');
const KEY = process.env.PRINT_QUEUE_API_KEY || '';

export const printQueueConfigured = () => Boolean(BASE && KEY);

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'X-API-Key': KEY, ...(init.headers || {}) },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`print-queue ${path} ${res.status}: ${data.error || res.statusText}`);
  return data as T;
}

export function uploadFile(buf: ArrayBuffer, name: string) {
  return call<{ id: string; name: string; size: number }>('/api/external/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    body: buf,
  });
}

export type QueueItem = {
  title: string;
  material_type: string;
  color?: string;
  est_grams: number; // ต่อชิ้น
  est_minutes: number; // ต่อชิ้น
  qty: number;
  price?: number; // ราคารวมของรายการนี้
  file_id?: string;
  note?: string;
};

export function createOrder(order: { customer: string; contact: string; note?: string; items: QueueItem[] }) {
  return call<{ order_no: string; jobs: { id: number }[] }>('/api/external/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...order, source: 'web' }),
  });
}
