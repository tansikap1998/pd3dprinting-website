import { Worker } from "bullmq";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

console.log("🚀 Starting CuraEngine Slicing Worker...");

new Worker(
  "slice",
  async (job) => {
    const { file, settings } = job.data;
    console.log(`[Job ${job.id}] Processing slicing for file: ${file}`);
    
    // Configs should be mapped here, but we use a default proxy config
    const configPath = path.resolve(__dirname, "../config/default.def.json");
    
    return new Promise((resolve, reject) => {
      // Security warning: Avoid injecting ${file} directly in real environments without sanitization
      exec(
        `CuraEngine slice -j ${configPath} -l ${file} -o /tmp/out_${job.id}.gcode`,
        (err, stdout, stderr) => {
          if (err) {
            console.error(`[Job ${job.id}] Error executing CuraEngine`, err);
            return reject(err);
          }

          // Parse stdout based on CuraEngine log format
          // Expected outputs: "Print time (s): 12345" and "Filament used: 12.34m"
          // We assume filament matched is in mm or m, user formula assumes input to DB is grams 
          // (you would multiply length * cross_section * density)
          const timeMatch = stdout.match(/Print time \(s\): (\d+)/);
          const filamentMatch = stdout.match(/Filament\(s\) used: ([\d.]+)/) || stdout.match(/Filament used: ([\d.]+)/);

          const time = timeMatch ? parseInt(timeMatch[1], 10) : 0;
          const filament = filamentMatch ? parseFloat(filamentMatch[1]) : 0.0;

          console.log(`[Job ${job.id}] Sliced! Time: ${time}s, Filament: ${filament}`);
          
          resolve({ time, filament });
        }
      );
    });
  },
  { connection }
);
