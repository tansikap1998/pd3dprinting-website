"use client";

import React, { useEffect, useState } from 'react';
import { parseSTL } from '@/lib/stlParser';

type EstimateResult = {
  weightG: number;
  printTimeMin: number;
  pricePerChip: number;
  total: number;
};

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [technology, setTechnology] = useState('FDM');
  const [material, setMaterial] = useState('PLA');
  const [infill, setInfill] = useState(25);
  const [layerHeight, setLayerHeight] = useState(0.20);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState('ขาว');
  const [customerName, setCustomerName] = useState('');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [order, setOrder] = useState<{ orderId: string; total: number } | null>(null);

  // เปลี่ยนไฟล์หรือค่าตั้งค่า → ต้องประเมินราคาใหม่
  useEffect(() => {
    setResult(null);
    setOrder(null);
  }, [file, technology, material, infill, layerHeight, quantity]);

  const handleOrder = async () => {
    if (!file || !result) return;
    if (!customerName.trim() || !contact.trim()) {
      setError('กรุณากรอกชื่อและเบอร์โทร / LINE ID');
      return;
    }
    setOrdering(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('technology', technology);
      fd.append('material', material);
      fd.append('color', color);
      fd.append('infill', String(infill));
      fd.append('layerHeight', String(layerHeight));
      fd.append('quantity', String(quantity));
      fd.append('customerName', customerName);
      fd.append('contact', contact);
      fd.append('note', note);
      const res = await fetch('/api/order', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'สั่งพิมพ์ไม่สำเร็จ');
      setOrder({ orderId: data.orderId, total: data.total });
    } catch (err: any) {
      setError(err.message || 'สั่งพิมพ์ไม่สำเร็จ');
    } finally {
      setOrdering(false);
    }
  };

  const materials = technology === 'FDM' 
    ? ['PLA', 'ABS', 'PETG'] 
    : ['Resin Standard', 'Resin Tough'];

  const handleEstimate = async () => {
    if (!file) {
      setError("Please upload an STL file.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // 1. Parse STL and get volume
      const arrayBuffer = await file.arrayBuffer();
      const { volume, surfaceArea, x, y, z } = await parseSTL(arrayBuffer);

      console.log(`Parsed STL: Dimensions = ${x} x ${y} x ${z} mm, Volume = ${volume} cm³`);

      // 2. Call Estimate API
      const res = await fetch('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volume,
          surfaceArea,
          height: z,
          infill: technology === 'Resin' ? 100 : infill, // Resin is solid
          material,
          layerHeight,
          quantity
        })
      });

      if (!res.ok) {
        throw new Error('Failed to estimate cost');
      }

      const data: EstimateResult = await res.json();
      setResult(data);

    } catch (err: any) {
      setError(err.message || "An error occurred during estimation.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-xl shadow-sm border border-gray-100 dark:bg-gray-900 dark:border-gray-800">
      <h1 className="text-2xl font-semibold tracking-tight">Upload 3D File</h1>
      <p className="text-sm text-gray-500 mt-2">Support .stl up to 100MB.</p>

      {/* File Upload */}
      <div className="mt-6 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
        <input 
          type="file" 
          accept=".stl"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="block w-full text-sm text-slate-500
            file:mr-4 file:py-2 file:px-4
            file:rounded-full file:border-0
            file:text-sm file:font-semibold
            file:bg-blue-50 file:text-blue-700
            hover:file:bg-blue-100
            cursor-pointer
          " 
        />
        {file && <p className="mt-4 text-sm text-green-600 font-medium">Selected: {file.name}</p>}
        {!file && <p className="mt-4 text-xs text-gray-400">Drag and drop file here</p>}
      </div>

      {/* Form Settings */}
      <div className="mt-8 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Technology</label>
            <select 
              className="w-full border border-gray-300 rounded-md shadow-sm p-2 bg-white dark:bg-gray-800 dark:border-gray-700"
              value={technology}
              onChange={(e) => {
                setTechnology(e.target.value);
                setMaterial(e.target.value === 'FDM' ? 'PLA' : 'Resin Standard');
              }}
            >
              <option value="FDM">FDM</option>
              <option value="Resin">Resin</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Material</label>
            <select 
              className="w-full border border-gray-300 rounded-md shadow-sm p-2 bg-white dark:bg-gray-800 dark:border-gray-700"
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
            >
              {materials.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">สี (Color)</label>
          <select
            className="w-full border border-gray-300 rounded-md shadow-sm p-2 bg-white dark:bg-gray-800 dark:border-gray-700"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          >
            {['ขาว', 'ดำ', 'เทา', 'แดง', 'น้ำเงิน', 'เขียว', 'เหลือง', 'ส้ม', 'ชมพู', 'ม่วง', 'ใส', 'อื่นๆ'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {technology === 'FDM' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Infill Density</label>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'เบา', value: 10 },
                { label: 'ปกติ', value: 25 },
                { label: 'แข็งแรง', value: 50 },
                { label: 'แข็งแรงมาก', value: 80 }
              ].map(opt => (
                <button
                  type="button"
                  key={opt.value}
                  onClick={() => setInfill(opt.value)}
                  className={`py-2 px-1 text-sm rounded border transition-colors ${
                    infill === opt.value 
                      ? 'bg-blue-50 border-blue-500 text-blue-700 dark:bg-blue-900 dark:border-blue-500 dark:text-blue-100' 
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
                  }`}
                >
                  <span className="block font-medium">{opt.label}</span>
                  <span className="block text-xs opacity-75">{opt.value}%</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Layer Height</label>
            <select 
              className="w-full border border-gray-300 rounded-md shadow-sm p-2 bg-white dark:bg-gray-800 dark:border-gray-700"
              value={layerHeight}
              onChange={(e) => setLayerHeight(Number(e.target.value))}
            >
              <option value={0.12}>0.12mm (Fine)</option>
              <option value={0.16}>0.16mm (High Quality)</option>
              <option value={0.20}>0.20mm (Standard)</option>
              <option value={0.28}>0.28mm (Draft)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity</label>
            <input 
              type="number" 
              min={1} 
              className="w-full border border-gray-300 rounded-md shadow-sm p-2 bg-white dark:bg-gray-800 dark:border-gray-700"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
          {error}
        </div>
      )}

      <button 
        onClick={handleEstimate}
        disabled={loading || !file}
        className="w-full mt-8 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors text-white font-medium rounded-lg shadow-sm"
      >
        {loading ? 'Estimating...' : 'Estimate Cost'}
      </button>

      {/* Result Display */}
      {result && (
        <div className="mt-8 bg-gray-50 dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Estimation Result</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white dark:bg-gray-900 p-4 rounded shadow-sm border border-gray-100 dark:border-gray-700">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Print Time</p>
              <p className="text-xl font-medium mt-1">
                {Math.floor(result.printTimeMin / 60)}h {result.printTimeMin % 60}m
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 p-4 rounded shadow-sm border border-gray-100 dark:border-gray-700">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Weight</p>
              <p className="text-xl font-medium mt-1">{result.weightG} g</p>
            </div>
            <div className="bg-white dark:bg-gray-900 p-4 rounded shadow-sm border border-gray-100 dark:border-gray-700">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Total Price</p>
              <p className="text-xl font-medium mt-1 text-blue-600 dark:text-blue-400">{result.total} THB</p>
            </div>
          </div>

          {order ? (
            <div className="mt-6 p-4 bg-green-50 border border-green-200 text-green-800 rounded-md dark:bg-green-950 dark:border-green-800 dark:text-green-200">
              <p className="font-semibold">✅ สั่งพิมพ์เรียบร้อย! เลขที่ออเดอร์ {order.orderId}</p>
              <p className="text-sm mt-1">ยอดรวม {order.total} THB · ทีมงานได้รับงานแล้ว และจะติดต่อกลับทาง {contact}</p>
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              <h4 className="font-medium text-gray-900 dark:text-white">ข้อมูลผู้สั่ง</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  className="w-full border border-gray-300 rounded-md p-2 bg-white dark:bg-gray-900 dark:border-gray-700"
                  placeholder="ชื่อ *"
                  value={customerName}
                  maxLength={100}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
                <input
                  className="w-full border border-gray-300 rounded-md p-2 bg-white dark:bg-gray-900 dark:border-gray-700"
                  placeholder="เบอร์โทร / LINE ID *"
                  value={contact}
                  maxLength={100}
                  onChange={(e) => setContact(e.target.value)}
                />
              </div>
              <textarea
                className="w-full border border-gray-300 rounded-md p-2 bg-white dark:bg-gray-900 dark:border-gray-700"
                placeholder="หมายเหตุถึงทีมงาน (ไม่บังคับ)"
                rows={2}
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                onClick={handleOrder}
                disabled={ordering}
                className="w-full px-4 py-3 bg-green-600 hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors text-white font-medium rounded-lg shadow-sm"
              >
                {ordering ? 'กำลังส่งออเดอร์...' : `ยืนยันสั่งพิมพ์ (${result.total} THB)`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
