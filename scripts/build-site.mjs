import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Publish only the website HTML: never publish source files or API Workers.
const output = 'dist';
const languages = ['sk', 'cs', 'de', 'pl', 'ro'];
// French is available after its translation PR is merged.
if (existsSync(join('fr', 'index.html'))) languages.push('fr');
if (!existsSync('index.html')) throw new Error('English homepage missing');
for (const language of languages) {
  if (!existsSync(join(language, 'index.html'))) {
    throw new Error('Missing locale: ' + language);
  }
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync('index.html', join(output, 'index.html'));
for (const language of languages) {
  mkdirSync(join(output, language), { recursive: true });
  cpSync(join(language, 'index.html'), join(output, language, 'index.html'));
}
console.log('Built NULL landing: English + ' + languages.join(', '));
