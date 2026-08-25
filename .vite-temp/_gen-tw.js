
    const postcss = require('postcss');
    const tailwindcss = require('tailwindcss');
    const autoprefixer = require('autoprefixer');
    const fs = require('fs');
    const css = '@tailwind base; @tailwind components; @tailwind utilities;';
    postcss([tailwindcss({ config: 'C:\\Users\\Rosary\\Desktop\\andeyunhui\\tailwind.config.js' }), autoprefixer()])
      .process(css, { from: undefined })
      .then(r => { fs.writeFileSync('C:\\Users\\Rosary\\Desktop\\andeyunhui\\.vite-temp\\_tailwind-plugins.css', r.css); });
  