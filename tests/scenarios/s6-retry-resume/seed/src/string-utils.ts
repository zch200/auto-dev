export function capitalize(str: string): string {
  if (str.length === 0) return ''
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

export function reverse(str: string): string {
  return str.split('').reverse().join('')
}
