import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    const user = await prisma.user.findFirst();
    if (!user) {
      console.log('No user found');
      return;
    }
    await prisma.user.update({
      where: {
        id: user.id,
        customerId: user.customerId, // This is non-unique
      } as any, // Cast to any to bypass TS error if any
      data: {
        name: user.name + ' updated'
      }
    });
    console.log('Update succeeded with customerId in where');
  } catch (err: any) {
    console.error('Update failed:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
