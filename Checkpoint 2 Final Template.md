# **Checkpoint 2: MERN Application Deployment with Secure Development Practices** 



<!-- Start of picture text -->
Name  Role  Signature<br><!-- End of picture text -->

[1] 

## **TABLE OF CONTENTS** 

|**GENERAL OBJECTIVE ........................................................................................................ 4**<br>**I. APPLICATION REQUIREMENTS ................................................................................... 4**|
|---|
|1. Frontend ............................................................................................................................. 4|
|2. Backend.............................................................................................................................. 4|
|3. Database ............................................................................................................................. 5|
|**II. MINIMUM SECURITY REQUIREMENTS ................................................................... 5**|
|1. Input Validation .................................................................................................................. 5|
|2. Password Hashing .............................................................................................................. 6|
|3. Authentication .................................................................................................................... 6|
|4. Role-Based Access Control (RBAC) ................................................................................. 7<br>5. Secure API Protection ........................................................................................................ 7|
|6. Secure HTTP Headers ........................................................................................................ 8|
|7. Secure Error Handling ....................................................................................................... 8|
|**III. ENVIRONMENT VARIABLE REQUIREMENTS ....................................................... 8**|
|**IV. DEPLOYMENT REQUIREMENTS ............................................................................... 9**|
|**V. HTTPS / ENCRYPTION IN TRANSIT .......................................................................... 10**|
|**VI. DATABASE SECURITY ................................................................................................ 10**|
|**VII. SECURITY TESTING REQUIREMENT ................................................................... 10**|
|**VIII. REQUIRED DEPLOYMENT DELIVERABLES .................................................... 11**|
|1. Source Code ..................................................................................................................... 11|
|2. Live Application URL...................................................................................................... 11|
|3. Test Accounts ................................................................................................................... 12|
|4. Security Documentation................................................................................................... 12|



[2] 

|**IX. DEMONSTRATION REQUIREMENT........................................................................ 12**<br>1. Application ....................................................................................................................... 12|
|---|
|2. Authentication .................................................................................................................. 13|
|3. RBAC ............................................................................................................................... 13|
|4.  Input Validation ............................................................................................................... 13|
|5. API Security ..................................................................................................................... 13|
|6.  Database .......................................................................................................................... 13|
|**X. MINIMUM SECURITY CHECKLIST .......................................................................... 14**|
|**XI. SUGGESTED GRADING RUBRIC.............................................................................. 15**|
|**XII. RECOMMENDED STUDENT TASK STATEMENT................................................ 15**|







[3] 

## **GENERAL OBJECTIVE** 

Students will deploy a functional **MERN (MongoDB, Express.js, React, Node.js)** application to a production environment and demonstrate that the application implements minimum secure development practices before and after deployment. 

The application must demonstrate the complete MERN request-response cycle, with React serving as the client/UI, Express and Node.js handling the API, Mongoose managing the application-to-database interaction, and MongoDB storing persistent data. 

## **I. APPLICATION REQUIREMENTS** 

Students must deploy an existing or newly developed MERN application. The application must have: 

### **1. Frontend** 

Developed using: 

   - React 

   - HTML/CSS 

   - JavaScript 

- Axios or Fetch API 

- The frontend must provide: 





- Login page 

- Registration page 

- Dashboard 

- CRUD interface 

- Navigation/menu 

- Form validation 

- Error/success messages 

- Logout functionality 

### **2. Backend** 

Developed using: 

- Node.js 

- Express.js 

- Mongoose 

The backend must provide: 

- RESTful API 

[4] 

- Routes 

- Controllers 

- Models 

- Middleware 

- Authentication 

- Authorization 

- Input validation 

- Error handling 

The REST API should follow resource-oriented URLs and appropriate HTTP methods such as GET, POST, PATCH/PUT, and DELETE. 

### **3. Database** 

#### Use: **MongoDB** 

The application must have at least: 

- 2 collections 

- Appropriate Mongoose schemas 

- Relationships where applicable 

- Required fields 

- Data validation 

Students should demonstrate that MongoDB is not accessed directly by React. The expected architecture is: 

**React → Express Route → Controller → Mongoose Model → MongoDB → Response → React UI** 

## **II. MINIMUM SECURITY REQUIREMENTS** 

This is the most important part of the deployment requirement. The deployed application **must not simply be a working MERN application** . It must demonstrate security controls based on Module 10. 

### **1. Input Validation** 

Students must validate: 

- Registration information 

- Login information 

- Form fields 

- URL parameters 

- Request body 

- IDs 

- Enumerated values where applicable 

[5] 

Invalid data must be rejected before reaching the business/database logic. Module 10 specifically requires treating external input as untrusted and using allow-lists or rule-based validation. 

**Example:** 

_body("email") .isEmail() .withMessage("Invalid email") .normalizeEmail()_ 

### **2. Password Hashing** 

Students **must never store plaintext passwords** . Passwords must be hashed using a modern password-hashing approach such as: 

- bcrypt 

- Argon2 

- equivalent approved approach 

Module 10 explicitly requires password hashes rather than plaintext passwords. 

Example: _const hashedPassword = await bcrypt.hash(password, 12);_ Login must use password comparison: 



_const isValid = await bcrypt.compare( password, user.password );_ 

### **3. Authentication** 

The application must identify authenticated users before allowing access to protected resources. Students may use: 

- JWT 

- Session-based authentication 

If JWT is used, the token must: 

- Be signed 

- Have an expiration 

- Contain only necessary claims 

- Be verified on protected requests 

Module 10 provides JWT as one approach to session management and demonstrates token expiration. 

[6] 

### **4. Role-Based Access Control (RBAC)** 

The application must implement **at least three roles** . For example: 

|**Role**|**Permissions**|
|---|---|
|Admin|Full system management|
|Staff|Create/read/update assigned records|
|User|View and manage own records|



Students must create an RBAC matrix. 

**Example** 

|**Function**|**Admin**|**Staff**|**User**|
|---|---|---|---|
|View records|✓|✓|✓|
|Create records|✓|✓|✓|
|Update records|✓|✓|Own only|
|Delete records|✓|✗|✗|
|Manage users|✓|✗|✗|
|View admin dashboard|✓|✗|✗|



Students must demonstrate that unauthorized users receive an appropriate response such as: **403 Forbidden** 

Module 10 emphasizes authorization, RBAC, and the **Principle of Least Privilege** , where users and services receive only the permissions necessary for their tasks. 

### **5. Secure API Protection** 

Every protected API endpoint must have appropriate security controls. Students must implement at least **four** of the following: 

- Authentication middleware 

- RBAC middleware 

- Input validation 

- Rate limiting 

- Secure error handling 

- Audit logging 

- Token expiration 

- Request validation 

Module 10 identifies these as important secure API practices. 

[7] 

### **6. Secure HTTP Headers** 

Students must use a security middleware such as: 

_npm install helmet_ 

Then: 

_import helmet from "helmet"; app.use(helmet());_ 

Module 10 specifically introduces Helmet for global security headers. 

### **7. Secure Error Handling** 

The API must **not expose** : 

- Stack traces 

- Database credentials 

- MongoDB connection strings 

- Internal file paths 

- JWT secrets 

• Passwords • Detailed database errors Instead of: _{ "error": "MongoServerError: ..." } Use something like: { "data": null, "error": { "message": "Unable to process request." } }_ 





This follows the module's emphasis on safe, consistent API responses and avoiding raw database errors. 

## **III. ENVIRONMENT VARIABLE REQUIREMENTS** 

Students **must not hard-code sensitive information** . The following must be stored in environment variables: 

_MONGODB_URI JWT_SECRET PORT_ 

[8] 

Example: _MONGODB_URI=mongodb+srv://... JWT_SECRET=your_secure_secret PORT=5000_ 

The .env file must not be uploaded to GitHub. 

Students must provide: 

_.env.example_ 

Example: 

_MONGODB_URI= JWT_SECRET= PORT=5000_ 

## **IV. DEPLOYMENT REQUIREMENTS** 

The application must be deployed so that it can be accessed through the Internet. Students must deploy: 

**Frontend:** React application hosted on a suitable cloud hosting platform. **Backend:** Node.js + Express API hosted on a suitable cloud hosting platform. **Database:** MongoDB hosted using a cloud-accessible MongoDB deployment. 



The final architecture should resemble: 



<!-- Start of picture text -->
React Frontend<br>(UI/UX)<br>HTTPS<br>¥<br>Express + Node<br>REST API<br>¥<br>Authentication<br>Authorization<br>Validation<br>Security Middleware<br>¥<br>Mongoose<br>ODM<br>¥<br>MongoDB<br>Database<br><!-- End of picture text -->

[9] 

## **V. HTTPS / ENCRYPTION IN TRANSIT** 

The deployed application must use **HTTPS** . Students must demonstrate that: 

_http://..._ 

is not being used for sensitive application communication when the production host provides HTTPS. The module identifies TLS/HTTPS as the control for protecting data while it moves between the browser, frontend, backend/API, and other services. 

Students should specifically verify that: 

- Login credentials are transmitted through HTTPS. 

- Authentication tokens are transmitted securely. 

- API requests use HTTPS. 

- MongoDB connection credentials are not exposed to the React frontend. 

## **VI. DATABASE SECURITY** 

Students must configure their MongoDB deployment securely. They must demonstrate: 

#### **Database Access** 

- Database authentication enabled 

- Restricted database user 

- Appropriate database permissions 





- No publicly exposed database credentials 

#### **Principle of Least Privilege** 

- The application database user should have only the permissions required by the application. 

This follows Module 10's requirement that service accounts should not receive unnecessary administrative privileges. 

## **VII. SECURITY TESTING REQUIREMENT** 

Students must perform security testing against their **own deployed application** . They should create a table like this: 

|**Test**|**Expected Result**|**Actual Result**|**Status**|
|---|---|---|---|
|Invalid registration data|400 Bad Request|400|PASS|
|Invalid login|401 Unauthorized|401|PASS|
|Access admin route as User|403 Forbidden|403|PASS|
|Missing JWT|401 Unauthorized|401|PASS|
|Invalid JWT|403 Forbidden|403|PASS|



[10] 

|**Test**|**Expected Result**|**Actual Result**|**Status**|
|---|---|---|---|
|Unauthorized DELETE|403 Forbidden|403|PASS|
|Invalid MongoDB ID|400 Bad Request|400|PASS|
|Excessive login requests|Rate limited|Blocked|PASS|



Important Safety Requirement. Security testing must be performed **only against the student's own application or instructor-provided test environment** . Module 10 explicitly frames vulnerability exercises around controlled sample code and prohibits testing real systems, live websites, public servers, or accounts. 

## **VIII. REQUIRED DEPLOYMENT DELIVERABLES** 

Students must submit the following: 

### **1. Source Code** 

GitHub repository containing: 



<!-- Start of picture text -->
project/<br>|<br>F client/<br>| fF  sre/<br>| package.json<br>| bn<br>|<br>Fe server/<br>| bE sre/<br>| |) Fe models/<br>| | controllers/<br>| | - routes/<br>| =| - middleware/<br>| | ‘“ server.js<br>| | package.json<br>|<br>F -env.example<br>/- README.md<br>‘— gitignore<br><!-- End of picture text -->



The organization should reflect the separation of React UI, Express routes/controllers, and Mongoose models emphasized in Module 08. 

### **2. Live Application URL** 

Students must submit: 

[11] 

**Frontend URL:** https://________________________ **Backend/API URL:** https://________________________ **GitHub Repository:** https://________________________ 

### **3. Test Accounts** 

Students must provide test accounts such as: 

_ADMIN Email: admin@test.com Password: ********_ 

_STAFF Email: staff@test.com Password: ********_ 

_USER Email: user@test.com Password: ********_ **4. Security Documentation** Students must prepare a short document containing: 



- System architecture diagram 

- MERN data-flow diagram 

- Database design 

- RBAC matrix 

- Authentication mechanism 

- Password hashing implementation 

- Input validation implementation 

- API security controls 

- HTTPS deployment 

- Security testing results 

## **IX. DEMONSTRATION REQUIREMENT** 

During the final demonstration, students must show the instructor: 

### **1. Application** 

1. Open the deployed React application. 

2. Register a user. 

3. Log in. 

[12] 

4. Display the dashboard. 

5. Perform CRUD operations. 

6. Log out. 

### **2. Authentication** 

Demonstrate that: 

- Unauthenticated users cannot access protected resources. 

- Invalid credentials are rejected. 

- Valid users can authenticate. 

### **3. RBAC** 

Log in using different roles. Demonstrate: 

- Admin → Admin Dashboard ✓ 

- Staff → Staff Functions ✓ 

- User → Admin Dashboard ✗ 

### **4.  Input Validation** 



   - Submit invalid data and demonstrate that the API rejects it. 

**5. API Security** 

Demonstrate: 

- Protected routes 

- JWT/token verification 

- Role checking 

- Secure error responses 

- Security headers 

### **6.  Database** 

Demonstrate that: 

- Data is stored in MongoDB. 

- Passwords are hashed. 

- The application communicates with MongoDB through the backend/Mongoose layer. 

[13] 

## **X. MINIMUM SECURITY CHECKLIST** 

Before deployment, students must complete this checklist: 

#### **MERN** 

- React frontend implemented 

- Express/Node backend implemented 

- MongoDB database implemented 

- Mongoose models implemented 

- REST API implemented 

- CRUD operations working 

#### **Authentication** 

- Registration implemented 

- Login implemented 

- Password hashing implemented 

- JWT/session authentication implemented 

- Logout implemented 

- Token expiration implemented 



#### **Authorization** 

- At least 3 roles 

- RBAC implemented 



- Protected routes implemented 

- Least privilege applied 

#### **API Security** 

- Input validation 

- Request validation 

- Safe error handling 

- Helmet/security headers 

- Rate limiting 

- Audit logging 

- No sensitive information in responses 

#### **Deployment** 

- Frontend deployed 

- Backend deployed 

- MongoDB deployed 

- HTTPS enabled 

- Environment variables configured 

- .env excluded from Git 

[14] 

- Production API URL configured 

- Database credentials protected 

## **XI. SUGGESTED GRADING RUBRIC** 

|**Criteria**|**Points**|
|---|---|
|MERN Application Functionality|20|
|REST API & CRUD Implementation|15|
|MongoDB/Mongoose Implementation|10|
|Authentication & Password Hashing|15|
|RBAC & Least Privilege|10|
|Input Validation & Secure API|10|
|HTTPS & Deployment Configuration|10|
|Security Testing & Documentation|5|
|Presentation/Demonstration|5|
|**TOTAL**|**100**|



#### **Performance Levels** 

|**Score**|**Performance**|
|---|---|
|90–100|Excellent – fully deployed and strongly secured|
|85–89|Very Good – deployed with minor security gaps|
|80–84|Good – functional but several security controls need improvement|
|75–79|Satisfactory – basic deployment achieved|
|Below 75|Needs Improvement – major deployment/security requirements incomplete|



## **XII. RECOMMENDED STUDENT TASK STATEMENT** 

**Practical Laboratory Requirement: Deploying a Secure MERN Application** 

**Task:** Deploy your MERN application to a production environment and demonstrate that it follows secure development practices. 

Your application must implement the complete MERN architecture: 

**React → Express/Node.js → Mongoose → MongoDB → API Response → React UI** 

**Minimum Requirements.** Your deployed application must include: 

- A functional React frontend. 

- A Node.js and Express REST API. 

- A MongoDB database accessed through Mongoose. 

- Working CRUD operations. 

- User registration and login. 

[15] 

- Password hashing using bcrypt, Argon2, or an equivalent secure approach. 

- Authentication using JWT or sessions. 

- At least three user roles. 

- Role-Based Access Control (RBAC). 

- Principle of Least Privilege. 

- Input validation for request bodies, parameters, and relevant fields. 

- Secure API error handling. 

- Security headers using an appropriate security middleware. 

- Rate limiting or equivalent API protection. 

- HTTPS for production communication. 

- Environment variables for secrets and database credentials. 

- A secure MongoDB configuration. 

- Security testing of protected and unauthorized operations. 

#### **Required Submission.** Submit the following: 

- GitHub repository 

- Live frontend URL 

- Live backend/API URL 

- MongoDB database configuration evidence 

- .env.example 

- System architecture diagram 



- MERN data-flow diagram 

- RBAC permission matrix 

- Security implementation documentation 

- Security testing results 



- Screenshots of the deployed application 

- Short video or live demonstration, if required by the instructor 

#### **Required Demonstration.** During the demonstration, show: 

- User registration. 

- User login. 

- Password hashing in the database. 

- CRUD operations. 

- Authentication-protected routes. 

- Role-based access control. 

- Rejection of unauthorized requests. 

- Input validation. 

- Secure API responses. 

- HTTPS deployment. 

- MongoDB data persistence. 

- Security testing results. 

**Security Rule.** All security testing must be conducted only against your own application or an instructor-provided test environment. Do not test vulnerabilities against real systems, public websites, public servers, or accounts that you do not own or have explicit permission to test. 

[16] 

**Final Goal.** The objective is not only to make the MERN application work. You must demonstrate that the application is **functional, deployable, secure, maintainable, and properly protected against common application and database security risks.** 





[17] 

