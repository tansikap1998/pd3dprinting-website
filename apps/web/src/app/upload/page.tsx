import React from 'react';

export default function Upload() {
  return (
    <div className="max-w-xl mx-auto p-6 bg-white rounded-xl shadow-sm border border-gray-100 dark:bg-gray-900 dark:border-gray-800">
      <h1 className="text-2xl font-semibold tracking-tight">Upload 3D File</h1>
      <p className="text-sm text-gray-500 mt-2">Support .stl, .obj up to 100MB.</p>

      <div className="mt-6 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
        <input type="file" className="block w-full text-sm text-slate-500
          file:mr-4 file:py-2 file:px-4
          file:rounded-full file:border-0
          file:text-sm file:font-semibold
          file:bg-blue-50 file:text-blue-700
          hover:file:bg-blue-100
        " />
        <p className="mt-4 text-xs text-gray-400">Drag and drop file here</p>
      </div>

      <button className="w-full mt-6 px-4 py-3 bg-blue-600 hover:bg-blue-700 transition-colors text-white font-medium rounded-lg shadow-sm">
        Estimate Cost
      </button>
    </div>
  );
}
