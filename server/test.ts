import { prisma } from './src/config/database';
async function run() {
  const users = await prisma.user.findMany({ 
    select: { id: true, name: true, role: true, email: true }, 
  });
  console.log(users);
}
run().catch(console.error).finally(() => prisma.$disconnect());
