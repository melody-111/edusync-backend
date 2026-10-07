import re

with open('src/socket/server.js', 'r') as f:
    content = f.read()

# Add aliases for students joining classrooms
alias_code = """        logger.debug(`${userRole} ${userId} joined school group: ${compositeGroup}`);

        // Fallbacks for school students when teacher inputs "Class X" or "X"
        if (user.className) {
          socket.join(`classroom:${tenantPrefix}${user.className}`);
          socket.join(`classroom:${tenantPrefix}Class ${user.className}`);
          socket.join(`school:${tenantPrefix}${user.className}:any`);
          socket.join(`school:${tenantPrefix}Class ${user.className}:any`);
        }"""

if '// Fallbacks for school students' not in content:
    content = content.replace('        logger.debug(`${userRole} ${userId} joined school group: ${compositeGroup}`);', alias_code)

with open('src/socket/server.js', 'w') as f:
    f.write(content)

