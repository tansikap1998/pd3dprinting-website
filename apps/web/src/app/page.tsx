import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24 text-center">
      <h1 className="text-5xl font-bold tracking-tight mb-4">PB3D Printing Hub</h1>
      <p className="text-lg text-gray-500 max-w-lg mb-8">
        Smart 3D printing estimations, automatic slicing, and seamless checkout.
      </p>
      
      <Link href="/upload" className="px-6 py-3 bg-blue-600 text-white font-medium rounded-lg shadow-sm hover:bg-blue-700 transition">
        Get Started →
      </Link>
    </main>
  );
}
