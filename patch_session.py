import re

with open('src/controllers/sessionController.js', 'r') as f:
    content = f.read()

# Make sure session.className is set if classroomId implies it
className_fallback = """
  // Fallback for school mode if only classroomId is provided but it looks like a class (e.g. "Class 10" or "10")
  if (classroomId && !className && !branch) {
    req.body.className = classroomId;
  }
"""

if '// Auto-end any existing active session' in content and 'Fallback for school mode' not in content:
    content = content.replace('  // Auto-end any existing active session', className_fallback + '\n  // Auto-end any existing active session')

with open('src/controllers/sessionController.js', 'w') as f:
    f.write(content)

