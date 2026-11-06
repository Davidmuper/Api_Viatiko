import prisma from '../src/services/db.service.js';
import bcrypt from 'bcryptjs';

async function main() {
  const hashAdmin = await bcrypt.hash('admin123', 10);
  const hashChofer = await bcrypt.hash('654321', 10);

  // 1. Empresa Base
  const empresa = await prisma.empresa.upsert({
    where: { nit: '900123456-1' },
    update: { nombre: 'Petroquímicos S.A.' },
    create: {
      nit: '900123456-1',
      nombre: 'Petroquímicos S.A.'
    }
  });

  // 2. Administrador
  await prisma.conductor.upsert({
    where: {
      empresaId_nombre: {
        empresaId: empresa.id,
        nombre: 'Administrador'
      }
    },
    update: { password: hashAdmin, rol: 'admin' },
    create: {
      empresaId: empresa.id,
      nombre: 'Administrador',
      placa: 'ADMIN-01',
      anticipo: 0,
      password: hashAdmin,
      rol: 'admin'
    }
  });

  // 3. Conductores
  const choferes = [
    { nombre: 'Leonardo Mantilla', placa: 'WNQ013', anticipo: 1200000 },
    { nombre: 'Edwin Posada', placa: 'WNP984', anticipo: 950000 },
    { nombre: 'Brayan Cortes', placa: 'TBL511', anticipo: 1500000 }
  ];

  for (const c of choferes) {
    await prisma.conductor.upsert({
      where: {
        empresaId_nombre: {
          empresaId: empresa.id,
          nombre: c.nombre
        }
      },
      update: { placa: c.placa, password: hashChofer, rol: 'conductor' },
      create: {
        empresaId: empresa.id,
        nombre: c.nombre,
        placa: c.placa,
        anticipo: c.anticipo,
        password: hashChofer,
        rol: 'conductor'
      }
    });
  }

  // 4. Cuentas PUC
  const pucs = [
    { nombre: 'Combustible', codigo: '519525' },
    { nombre: 'Peajes', codigo: '519530' },
    { nombre: 'Mantenimiento / Taller', codigo: '514510' },
    { nombre: 'Hospedaje / Alimentación', codigo: '519595' },
    { nombre: 'Cargue / Descargue', codigo: '519535' },
    { nombre: 'Parqueadero / Lavado', codigo: '519540' },
    { nombre: 'Báscula', codigo: '519595' },
    { nombre: 'Otros', codigo: '519595' }
  ];

  for (const p of pucs) {
    await prisma.puc.upsert({
      where: {
        empresaId_nombre: {
          empresaId: empresa.id,
          nombre: p.nombre
        }
      },
      update: { codigo: p.codigo },
      create: {
        empresaId: empresa.id,
        nombre: p.nombre,
        codigo: p.codigo
      }
    });
  }

  console.log('Base de datos en Neon sincronizada con usuarios y claves seguras.');
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
