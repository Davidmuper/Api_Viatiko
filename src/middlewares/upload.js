import multer from 'multer';

// Almacenamiento en memoria RAM (Buffer) para enviarlo directo a la IA sin tocar disco duro
const storage = multer.memoryStorage();

// Filtro de seguridad: Solo formatos de imagen válidos
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no permitido. Solo se aceptan imágenes JPG, PNG o WEBP.'), false);
  }
};

// Límite de tamaño: Máximo 8 MB por imagen
export const uploadRecibo = multer({
  storage: storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: fileFilter
});