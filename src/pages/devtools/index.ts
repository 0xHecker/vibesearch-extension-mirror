import Browser from 'webextension-polyfill';

Browser
  .devtools
  .panels
  .create('Dev Tools', 'favicon_squared-32.png', 'src/pages/devtools/index.html')
  .catch(console.error);
