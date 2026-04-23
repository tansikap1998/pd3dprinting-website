export function calculatePrice({ filament, time }: { filament: number; time: number }): number {
  // Using user provided blueprint formula
  const pricePerGram = 0.8;
  const pricePerHour = 50;
  const baseFee = 20;
  const margin = 1.3; // 30% margin

  const materialCost = filament * pricePerGram;
  const timeCost = (time / 3600) * pricePerHour;

  const subtotal = materialCost + timeCost + baseFee;
  return subtotal * margin;
}
