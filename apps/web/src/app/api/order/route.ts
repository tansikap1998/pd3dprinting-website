import { NextResponse } from 'next/server';
import { parseSTL } from '@/lib/stlParser';
import { estimate, MATERIALS, INFILLS, LAYER_HEIGHTS } from '@/lib/estimate';
import { createOrder, printQueueConfigured, uploadFile } from '@/lib/printQueue';

export const runtime = 'nodejs';

const MAX_BYTES = 100 * 1024 * 1024;
const COLORS = ['ขาว', 'ดำ', 'เทา', 'แดง', 'น้ำเงิน', 'เขียว', 'เหลือง', 'ส้ม', 'ชมพู', 'ม่วง', 'ใส', 'อื่นๆ'];

// รับออเดอร์จากหน้า /upload: คำนวณราคาใหม่ฝั่ง server จากไฟล์จริง แล้วส่งไฟล์และงานเข้าคิวพิมพ์ (แจ้งทีมใน LINE)
export async function POST(req: Request) {
  try {
    if (!printQueueConfigured()) {
      return NextResponse.json({ error: 'ระบบรับออเดอร์ยังไม่ได้ตั้งค่า (PRINT_QUEUE_URL / PRINT_QUEUE_API_KEY)' }, { status: 503 });
    }
    const form = await req.formData();
    const file = form.get('file');
    const str = (k: string) => String(form.get(k) ?? '').trim();

    if (!(file instanceof File)) return bad('กรุณาแนบไฟล์ .stl');
    if (!/\.stl$/i.test(file.name)) return bad('รองรับเฉพาะไฟล์ .stl');
    if (file.size > MAX_BYTES) return bad('ไฟล์ใหญ่เกิน 100MB');

    const technology = str('technology') === 'Resin' ? 'Resin' : 'FDM';
    const material = str('material');
    if (!(MATERIALS[technology] as readonly string[]).includes(material)) return bad('วัสดุไม่ถูกต้อง');
    const infill = technology === 'Resin' ? 100 : Number(str('infill'));
    if (technology === 'FDM' && !INFILLS.includes(infill)) return bad('ค่า infill ไม่ถูกต้อง');
    const layerHeight = Number(str('layerHeight'));
    if (!LAYER_HEIGHTS.includes(layerHeight)) return bad('ค่า layer height ไม่ถูกต้อง');
    const quantity = Number(str('quantity'));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return bad('จำนวนต้องอยู่ระหว่าง 1-100');
    const color = COLORS.includes(str('color')) ? str('color') : '';
    const customer = str('customerName').slice(0, 100);
    const contact = str('contact').slice(0, 100);
    const note = str('note').slice(0, 500);
    if (!customer || !contact) return bad('กรุณากรอกชื่อและช่องทางติดต่อ');

    const buf = await file.arrayBuffer();
    let dims: { x: number; y: number; z: number; volume: number };
    try {
      dims = await parseSTL(buf);
    } catch {
      return bad('อ่านไฟล์ STL ไม่ได้');
    }
    if (!(dims.volume > 0)) return bad('ไฟล์ STL ไม่มีปริมาตร (โมเดลอาจไม่ปิด)');

    const est = estimate({ volume: dims.volume, infill, material, layerHeight, quantity });

    const uploaded = await uploadFile(buf, file.name);
    const spec = [
      `${technology} ${material}${color ? ' ' + color : ''}`,
      technology === 'FDM' ? `infill ${infill}%` : '',
      `layer ${layerHeight}mm`,
      `ขนาด ${dims.x}×${dims.y}×${dims.z} mm`,
    ].filter(Boolean).join(' · ');

    const order = await createOrder({
      customer,
      contact,
      note,
      items: [{
        title: file.name.replace(/\.stl$/i, ''),
        material_type: technology === 'Resin' ? 'Resin' : material,
        color: color && color !== 'อื่นๆ' ? color : undefined,
        est_grams: est.weightG,
        est_minutes: est.printTimeMin,
        qty: quantity,
        price: est.total,
        file_id: uploaded.id,
        note: spec,
      }],
    });

    return NextResponse.json({ orderId: order.order_no, ...est }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'สร้างออเดอร์ไม่สำเร็จ กรุณาลองใหม่' }, { status: 500 });
  }
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
