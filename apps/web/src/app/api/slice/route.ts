import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { fileId, settings } = body;

    if (!fileId) {
      return NextResponse.json({ error: 'File ID is required.' }, { status: 400 });
    }

    // TODO: Connect to Redis/BullMQ to enqueue the job to the external Docker worker running CuraEngine.
    // const job = await sliceQueue.add('slice', { fileId, settings });

    return NextResponse.json({ message: 'Slicing job successfully queued!', jobId: 'sim_1234' }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to enqueue slicing job.', details: String(error) }, { status: 500 });
  }
}
