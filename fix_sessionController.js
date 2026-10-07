const fs = require('fs');
const file = 'src/controllers/sessionController.js';
let content = fs.readFileSync(file, 'utf8');

// Replace the prioritization logic
content = content.replace(
  "if (session.classroomId) {",
  "if (session.className && session.section) {\n      targetRoom = `school:${tenantPrefix}${session.className}:${session.section}`;\n    } else if (session.classroomId) {"
);

fs.writeFileSync(file, content);
console.log('Fixed sessionController.js prioritization');
