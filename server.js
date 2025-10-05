const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();
const morgan = require("morgan");
const winston = require("winston");
const path = require("path"); 

const app = express();

app.use(cors());
app.use(express.json());

// Serving static files (assuming frontend is in the root or a build directory)
app.use(express.static(path.join(__dirname))); 

// Load MongoDB Atlas URI from environment variables (must be set in Vercel settings)
const atlasURI = process.env.MONGO_URI;

// ==========================================================
// ⭐️ CRITICAL FIX: VERCEL/SERVERLESS CONNECTION CACHING ⭐️
// This logic caches the database connection, preventing timeouts on Vercel.
// ==========================================================

// Define the global cache object
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
  // 1. Return cached connection if available
  if (cached.conn) {
    console.log('Using existing cached DB connection.');
    return cached.conn;
  }

  // 2. Create a new promise if none exists
  if (!cached.promise) {
    if (!atlasURI) {
        throw new Error('MONGO_URI is not defined in environment variables.');
    }
    
    const opts = {
      bufferCommands: false, // Essential for serverless functions
    };

    cached.promise = mongoose.connect(atlasURI, opts).then((mongoose) => {
      console.log('New DB connection established and cached.');
      return mongoose;
    }).catch(err => {
        console.error('Atlas connection error:', err);
        throw err; 
    });
  }

  // 3. Await the promise and store the connection
  cached.conn = await cached.promise;
  return cached.conn;
};

// ==========================================================
// LOGGER & MIDDLEWARE SETUP (Unchanged)
// ==========================================================

// Configure Winston Logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

app.use(
  morgan(":method :url :status :response-time ms - :res[content-length]")
);

// Custom API Logger Middleware
const apiLogger = (req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      params: req.params,
      query: req.query,
      body: req.method !== "GET" ? req.body : undefined,
    });
  });
  next();
};

app.use(apiLogger);

// Error Handling Middleware
app.use((err, req, res, next) => {
  logger.error({
    message: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    params: req.params,
    query: req.query,
    body: req.method !== "GET" ? req.body : undefined,
  });

  res.status(500).json({ message: "Internal server error" });
});

// ==========================================================
// MODELS (Unchanged)
// ==========================================================

const studentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    course: { type: String, required: true },
    enrollmentDate: { type: Date, required: true },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

const Student = mongoose.model("Student", studentSchema);

const courseSchema = new mongoose.Schema(
    {
        name:{ type: String, required: true, unique: true },
        description:{ type: String, required: true },
        duration: { type: Number, required: true },
        status:{ type: String, enum:["active", "inactive"], default: "active" }
    },{
        timestamps: true
    }
);

const Course  = mongoose.model("Course", courseSchema);

// ==========================================================
// Middleware to ensure DB connection before every API route
// ==========================================================
const ensureDbConnection = async (req, res, next) => {
    try {
        await connectDB(); // This uses the cached connection or establishes a new one
        next();
    } catch (error) {
        // If connection fails, immediately respond with a service error
        res.status(503).json({ message: 'Database connection unavailable' });
    }
};

// Apply the middleware to all API routes
app.use('/api', ensureDbConnection);


//--------------------------------------------------------------
// Course Routes (Unchanged Logic)
//--------------------------------------------------------------

app.get('/api/courses', async (req, res) =>{
       try {
         const courses = await Course.find().sort({ name: 1 });
         logger.info(`Retrieved ${courses.length} courses successfully`);
         res.json(courses);
       } catch (error) {
         logger.error("Error fetching courses:", error);
         res.status(500).json({ message: error.message });
       }
})

app.post("/api/courses", async (req, res) => {
  try {
    const course = new Course(req.body);
    const savedCourse = await course.save();
    logger.info("New course created:", {
      courseId: savedCourse._id,
      name: savedCourse.name,
    });
    res.status(201).json(savedCourse);
  } catch (error) {
    logger.error("Error creating course:", error);
    res.status(400).json({ message: error.message });
  }
});

app.put("/api/courses/:id", async (req, res) => {
  try {
    const course = await Course.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!course) {
      logger.warn("Course not found for update:", { courseId: req.params.id });
      return res.status(404).json({ message: "Course not found" });
    }
    logger.info("Course updated successfully:", {
      courseId: course._id,
      name: course.name,
    });
    res.json(course);
  } catch (error) {
    logger.error("Error updating course:", error);
    res.status(400).json({ message: error.message });
  }
});

app.delete("/api/courses/:id", async (req, res) => {
  try {
    const enrolledStudents = await Student.countDocuments({
      course: req.params.id,
    });
    if (enrolledStudents > 0) {
      logger.warn("Attempted to delete course with enrolled students:", {
        courseId: req.params.id,
        enrolledStudents,
      });
      return res
        .status(400)
        .json({ message: "Cannot delete course with enrolled students" });
    }

    const course = await Course.findByIdAndDelete(req.params.id);
    if (!course) {
      logger.warn("Course not found for deletion:", {
        courseId: req.params.id,
      });
      return res.status(404).json({ message: "Course not found" });
    }
    logger.info("Course deleted successfully:", {
      courseId: course._id,
      name: course.name,
    });
    res.json({ message: "Course deleted successfully" });
  } catch (error) {
    logger.error("Error deleting course:", error);
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/courses/:id", async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }
    res.json(course);
  } catch (error) {
    logger.error("Error fetching course:", error);
    res.status(500).json({ message: error.message });
  }
});

//--------------------------------------------------------------
// Student Routes (Unchanged Logic)
//--------------------------------------------------------------

app.get("/api/students", async (req, res) => {
  try {
    const students = await Student.find().sort({ createdAt: -1 });
    logger.info(`Retrieved ${students.length} students successfully`);
    res.json(students);
  } catch (error) {
    logger.error("Error fetching students:", error);
    res.status(500).json({ message: error.message });
  }
});

app.post("/api/students", async (req, res) => {
  try {
    const student = new Student(req.body);
    const savedStudent = await student.save();
    logger.info("New student created:", {
      studentId: savedStudent._id,
      name: savedStudent.name,
      course: savedStudent.course,
    });
    res.status(201).json(savedStudent);
  } catch (error) {
    logger.error("Error creating student:", error);
    res.status(400).json({ message: error.message });
  }
});

app.put("/api/students/:id", async (req, res) => {
  try {
    const student = await Student.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!student) {
      logger.warn("Student not found for update:", {
        studentId: req.params.id,
      });
      return res.status(404).json({ message: "Student not found" });
    }
    logger.info("Student updated successfully:", {
      studentId: student._id,
      name: student.name,
      course: student.course,
    });
    res.json(student);
  } catch (error) {
    logger.error("Error updating student:", error);
    res.status(400).json({ message: error.message });
  }
});

app.delete("/api/students/:id", async (req, res) => {
  try {
    const student = await Student.findByIdAndDelete(req.params.id);
    if (!student) {
      logger.warn("Student not found for deletion:", {
        studentId: req.params.id,
      });
      return res.status(404).json({ message: "Student not found" });
    }
    logger.info("Student deleted successfully:", {
      studentId: student._id,
      name: student.name,
      course: student.course,
    });
    res.json({ message: "Student deleted successfully" });
  } catch (error) {
    logger.error("Error deleting student:", error);
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/students/search", async (req, res) => {
  try {
    const searchTerm = req.query.q;
    logger.info("Student search initiated:", { searchTerm });

    const students = await Student.find({
      $or: [
        { name: { $regex: searchTerm, $options: "i" } },
        { course: { $regex: searchTerm, $options: "i" } },
        { email: { $regex: searchTerm, $options: "i" } },
      ],
    });

    logger.info("Student search completed:", {
      searchTerm,
      resultsCount: students.length,
    });
    res.json(students);
  } catch (error) {
    logger.error("Error searching students:", error);
    res.status(500).json({ message: error.message });
  }
});

app.get("/api/students/:id", async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid student ID format' });
        }
        
        const student = await Student.findById(req.params.id).lean();
        
        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }
        
        res.json(student); 
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

//--------------------------------------------------------------
// Dashboard & Health Routes (Unchanged Logic)
//--------------------------------------------------------------

// Dashboard Stats
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const stats = await getDashboardStats();
        logger.info('Dashboard statistics retrieved successfully:', stats);
        res.json(stats);
    } catch (error) {
        logger.error('Error fetching dashboard stats:', error);
        res.status(500).json({ message: error.message });
    }
});

// Helper function for dashboard stats
async function getDashboardStats() {
    const totalStudents = await Student.countDocuments();
    const activeStudents = await Student.countDocuments({ status: 'active' });
    const totalCourses = await Course.countDocuments();
    const activeCourses = await Course.countDocuments({ status: 'active' });
    const graduates = await Student.countDocuments({ status: 'inactive' });
    const courseCounts = await Student.aggregate([
        { $group: { _id: '$course', count: { $sum: 1 } } }
    ]);

    return {
        totalStudents,
        activeStudents,
        totalCourses,
        activeCourses,
        graduates,
        courseCounts,
        successRate: totalStudents > 0 ? Math.round((graduates / totalStudents) * 100) : 0
    };
}


// Basic health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        timestamp: new Date(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    });
});


// Detailed health check endpoint with MongoDB connection status
app.get('/health/detailed', async (req, res) => {
    try {
        const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
        
        const heapMemoryUsage = process.memoryUsage();
        const currentUptime = process.uptime(); 
        
        const systemInfo = {
            memory: {
                total: Math.round(heapMemoryUsage.heapTotal / 1024 / 1024),
                used: Math.round(heapMemoryUsage.heapUsed / 1024 / 1024),
                unit: 'MB'
            },
            uptime: {
                seconds: Math.round(currentUptime),
                formatted: formatUptime(currentUptime)
            },
            nodeVersion: process.version,
            platform: process.platform
        };

        const healthCheck = {
            status: 'UP',
            timestamp: new Date().toISOString(),
            database: {
                status: dbStatus,
                name: 'MongoDB',
                host: mongoose.connection.host || 'N/A' 
            },
            system: systemInfo,
            environment: process.env.NODE_ENV || 'development'
        };

        res.status(200).json(healthCheck);
    } catch (error) {
        res.status(500).json({
            status: 'DOWN',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});


// Helper function to format uptime
function formatUptime(seconds) {
    seconds = Math.floor(seconds); 
    
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;

    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (parts.length === 0 || remainingSeconds > 0) parts.push(`${remainingSeconds}s`); 

    return parts.join(' ');
}

//--------------------------------------------------------------
// Catch-All Route for Frontend (SPA Routing) - MUST BE LAST
//--------------------------------------------------------------

app.get('*', (req, res) => {
    // This serves the index.html file for all non-API routes
    res.sendFile(path.join(__dirname,'index.html')); 
});


// ==========================================================
// ⭐️ CRITICAL FIX 3: EXPORT THE APP FOR VERCEL ⭐️
// We remove app.listen() and export the app instance.
// ==========================================================


// IMPORTANT: Do NOT commit this temporary block to your main branch.
// We still need to export the app for Vercel.
module.exports = app; // Keeping this export is fine, but the listen is key for local run.