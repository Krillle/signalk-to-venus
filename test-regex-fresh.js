// Force fresh import test
import('./settings.js?v=' + Date.now()).then(({default: settings}) => {
  const testPaths = [
    'tanks.fuel.0.currentLevel',      // numeric (old style)
    'tanks.fuel.main.currentLevel',   // named (new style)  
    'tanks.fuel.starboard.currentLevel', // named (new style)
    'tanks.freshWater.port.currentLevel', // named (new style)
    'tanks.diesel.tank1.currentLevel'     // alphanumeric
  ];

  console.log('Fresh Tank regex test:');
  console.log('Tank regex:', settings.tankRegex);
  console.log('Testing tank ID patterns:');
  testPaths.forEach(path => {
    const matches = settings.tankRegex.test(path);
    console.log(`  ${matches ? '✅' : '❌'} ${path}`);
  });
}).catch(console.error);
