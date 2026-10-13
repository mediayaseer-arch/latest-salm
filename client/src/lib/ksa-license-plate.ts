export function isValidSaudiPlate(value: string) {
  return /^[A-Z]{1,3}[0-9]{1,4}$/.test(value);
}
