/**  UNFINISHED **/
/* eslint-disable no-unused-vars */

const Promise = require('bluebird');
var concat = require('concat-files');
var B2 = require('easy-backblaze');
const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');
const mkdirp = Promise.promisifyAll(require('mkdirp'));
var randomstring = require('randomstring');

const redisClient = require('../../config/redis');

const pagination = require('../../lib/helpers/pagination');

const User = require('../../models/index').User;
const Upload = require('../../models/index').Upload;


const sendMessageToDiscord = require('../../lib/moderation/discordWebhooks');

const { saveAndServeFilesDirectory } = require('../../lib/helpers/settings');
const getMediaType = require('../../lib/uploading/media');
const { b2, bucket, hostUrl } = require('../../lib/uploading/backblaze');

const ffmpegHelper = require('../../lib/uploading/ffmpeg');
const uploadHelpers = require('../../lib/uploading/helpers');
const backblaze = require('../../lib/uploading/backblaze');

// console.log(`SAVE AND SERVE FILES DIRECTORY: ${saveAndServeFilesDirectory}`);

var resumable = require('../../lib/uploading/resumable.js')(__dirname +  '/upload');

const moderationUpdatesToDiscord = process.env.MODERATION_UPDATES_TO_DISCORD == 'true';

const winston = require('winston');
//
const { createLogger, format, transports } = require('winston');

const uploadsOn = process.env.UPLOADS_ON;
console.log(`UPLOADS ON: ${uploadsOn}\n`);

let uploadLogger;
if(process.env.NODE_ENV !== 'production'){
  // PULL OUT TO OWN FILE
  uploadLogger = winston.createLogger({
    level: 'info',
    format: format.combine(
      format.splat(),
      format.simple()
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: 'logfile.log' })
    ]
  });

} else {
  uploadLogger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: 'logfile.log' })
    ]
  });

}


exports.getUploadProgress = async(req, res) => {
  // example request /user/fred/j9dle/progress




  const uniqueTag = req.body.uniqueTag;
  // nuspa41uploadProgress
  const string = `${uniqueTag}uploadProgress`;


  const value = await redisClient.getAsync(`${uniqueTag}uploadProgress`);

  // console.log(value);
  //
  // console.log(req.params);
  //
  // console.log(req.body);
  //
  // console.log(uniqueTag);


  return res.send(value)

};


function areUploadsOff(uploadsOn, isNotTrustedUser){
  if(uploadsOn == 'false' && !req.user.privs.autoVisibleUpload){
    console.log('HERE');
    res.status(500);
    return res.send({ message: 'UPLOADS_OFF'});
  }
}

function testIfUserRestricted(user, logObject, res){
  const userStatusIsRestricted = user.status == 'uploadRestricted';

  if(userStatusIsRestricted){
    uploadLogger.info('User upload status restricted', logObject);

    res.status(403);
    return res.send('Sorry your account is restricted');
  }
}

const getExtensionString = path.extname;

function generateLogObject(){

}


function moderationIsRequired (user){
  const restrictUntrustedUploads = process.env.RESTRICT_UNTRUSTED_UPLOADS == 'true';

  // if the user is not allowed to auto upload
  const userIsUntrusted = !user.privs.autoVisibleUpload;

  // moderation is required if restrict uploads is on and user is untrusted
  const requireModeration = restrictUntrustedUploads && userIsUntrusted;

  return requireModeration;
}


async function checkIfAlreadyUploaded(user, title, res){
  // TODO: File size check

  const alreadyUploaded = await Upload.findOne({
    uploader: user._id,
    title,
    visibility: 'public',
    status: 'completed'
  });

  if(alreadyUploaded){
    uploadLogger.info('Upload title already uploaded', logObject);
    res.status(500);
    return res.send({message: 'ALREADY-UPLOADED'});
  }
}

/** RESPOND EARLY IF ITS AN UNKNOWN FILE TYPE **/
const testIsFileTypeUnknown = async function(upload, fileType, fileExtension, logObject){
  if(fileType == 'unknown'){
    upload.status = 'rejected';

    await upload.save();

    logObject.uploadExtension = fileExtension;
    uploadLogger.info('Unknown file type', logObject);

    res.status(500);
    return res.send({message: 'UNKNOWN FILETYPE'});
  }

};


/**
 * POST /api/upload
 * File Upload API example.
 */
exports.postFileUpload = async(req, res) => {

  try {

    const isNotTrustedUser = !req.user.privs.autoVisibleUpload;

    areUploadsOff(uploadsOn, isNotTrustedUser);

    const user = req.user;

    const { channelUrl } = user;

    const { description, visibility, title, uploadToken } = req.query;

    // setup logobject for winston
    let logObject = {
      user: user && user.channelUrl,
      upload: title
    };

    // use an uploadToken if it exists but there is no req.user
    // load req.user with the found user
    if(!user && uploadToken){
      req.user = await User.findOne({
        uploadToken
      });
    }
    // ends the response early if user is restricted
    testIfUserRestricted(user, logObject, res);

    checkIfAlreadyUploaded(user, title, res);

    /** WHEN A NEW CHUNK IS COMPLETED **/
    // why can't change name to fileName ?
    resumable.post(req, async function(status, filename, original_filename, identifier){

      console.log(req.body);

      // TODO: would be nice to do a log here so you can see the chunks come through on the backend rather than divining from the request

      // console.log(req.query);

      const { chunkNumber, totalChunks, rating } = req.query;

      const { resumableTotalSize, resumableChunkNumber, resumableTotalChunks } = req.body;

      // uploadLogger.info(`Processing chunk number ${chunkNumber} of ${totalChunks} `, logObject);

      const fileName = filename;
      const fileType = getMediaType(filename);
      let fileExtension = getExtensionString(filename);

      const fileSize = resumableTotalSize;

      if(fileExtension == '.MP4'){
        fileExtension = '.mp4';
      }


      let category = req.query.category;
      if(category == 'undefined' || category == undefined){
        category = 'uncategorized';
      }

      let subcategory = req.query.subcategory;
      if(subcategory == 'undefined' || subcategory == undefined){
        subcategory = 'uncategorized';
      }

      const uniqueTag = randomstring.generate(7);

      let upload = new Upload({
        uploader: user._id,
        title,
        description,
        visibility,
        originalFileName: fileName,
        fileType,
        hostUrl,
        fileExtension,
        fileSize,
        category,
        subcategory,
        rating,
        uniqueTag
      });

      // user this after upload object is made because it saves it to db
      testIsFileTypeUnknown(upload, fileType, fileExtension, logObject);

      // where is this used?
      let uploadPath = `./upload/${identifier}`;

      /** FINISHED DOWNLOADING EVERYTHING **/
      if(resumableChunkNumber == resumableTotalChunks){
        let responseSent = false;

        const channelUrl = user.channelUrl;

        const hostFilePath = `${channelUrl}/${uniqueTag}`;

        // TODO: 'uploadServer' functionality is totally unsupported
        // const uploadServer = process.env.UPLOAD_SERVER || 'uploads1' ;

        const requireModeration = moderationIsRequired(user);

        if(requireModeration){
          upload.visibility = 'pending';
        }

        await upload.save();

        // uploadLogger.info('Upload document added to db', Object.assign({}, logObject, upload));

        // TODO: make this smarter, url etc
        if(requireModeration && moderationUpdatesToDiscord){
          await sendMessageToDiscord(`Pending upload requires moderation on NodeTube.live. ${new Date()}`);
        }

        /** FILE PROCESSING */

        // send user to the upload page and say it's still  processing if the request is waiting after 25 seconds
        // cant seem to pull it out of controller since it accesses timing variables in this backend
        // sure you could use express to get around this but it stays for the time being
        // it seems for sure loaded into memory (resp
        (async function(){
          await Promise.delay(1000 * 25);

          let timeoutUpload = await Upload.findOne({uniqueTag});

          if(timeoutUpload.status !== 'completed'){
            // note the upload is still processing
            timeoutUpload.status = 'processing';
            await timeoutUpload.save();

            uploadLogger.info('Still processing after 25s', logObject);

            // note that we've responded to the user and send them to processing page
            if(!responseSent){
              responseSent = true;

              // dont return here so the rest of the code can process
              res.send({
                message: 'ABOUT TO PROCESS',
                url: `/user/${channelUrl}/${uniqueTag}?autoplay=off`
              });
            }
          }
        })();

        /** turn filenames into an array for concatenation **/

        const fileNameArray = [];
        for(let x = 1; x < parseInt(resumableTotalChunks, 10) + 1; x++){
          fileNameArray.push(`${uploadPath}/${x}`);
        }

        // I feel like I pulled this into a promise once and it didn't work

        /** CONCATENATE FILES AND BEGIN PROCESSING **/
        concat(fileNameArray, `${uploadPath}/convertedFile`, async function(err){
          if(err)throw err;

          let bitrate;

          uploadLogger.info('Concat done', logObject);

          const response = await ffmpegHelper.ffprobePromise(`${uploadPath}/convertedFile`);

          const { codecName, codecProfile } = response.streams[0];

          // TODO: what are the units of measurement here?
          bitrate = response.format.bit_rate / 1000;

          uploadLogger.info(`BITRATE: ${bitrate}`, logObject);


          // where to save the files locally
          const channelUrlFolder = `${saveAndServeFilesDirectory}/${user.channelUrl}`;

          // file name to save
          const fileName = `${uniqueTag}${fileExtension}`;

          // the full local path of where the file will be served from
          let fileInDirectory = `${channelUrlFolder}/${fileName}`;


          // make user's folder if it doesn't exist yet
          await mkdirp.mkdirpAsync(channelUrlFolder);

          /** MOVE CONVERTED FILE TO PROPER DIRECTORY **/
          await fs.move(`./${uploadPath}/convertedFile`, fileInDirectory);

          uploadLogger.info('Moved file to user\'s directory', logObject);

          /** DELETE RESUMABLE PARTS **/
          await fs.remove(`./${uploadPath}`);

          uploadLogger.info('Removed original file parts', logObject);

          // save filesize
          const convertedFileStats = fs.statSync(fileInDirectory);

          upload.fileSize = convertedFileStats.size;
          await upload.save();

          console.log('done moving file');




          const specificMatches = ( codecName == 'hevc' || codecProfile == 'High 4:4:4 Predictive' );

          if(specificMatches || bitrate > 2500) {
            upload.fileType = 'convert';
          }










          /** CONVERT AND UPLOAD VIDEO **/
          // TODO: PULL THIS OUT INTO A LIBRARY
          if(upload.fileType == 'convert'){

            upload.status = 'processing';
            await upload.save();

            responseSent = true;
            res.send({
              message: 'ABOUT TO PROCESS',
              url: `/user/${channelUrl}/${uniqueTag}?autoplay=off`
            });

            // take a thumbnail using ffmpeg and save it to the document as uniqueTag.png
            // TODO: this also uploads to B2, this should be pulled out into its own fucntion
            await ffmpegHelper.takeAndUploadThumbnail(fileInDirectory, uniqueTag, hostFilePath, bucket, upload, channelUrl, b2);

            uploadLogger.info('Captured thumbnail', logObject);

            // if bitrate is above 2500 we also compress it.
            // if we wanted to be really nice we would convert one where we don't compress it at all
            // something to consider in the future

            const savePath = `${saveAndServeFilesDirectory}/${channelUrl}/${uniqueTag}.mp4`;

            // TODO: savePath and fileInDirectory are the same thing, need to clean this code up

            if(fileExtension == '.mp4'){
              await fs.move(savePath, `${saveAndServeFilesDirectory}/${channelUrl}/${uniqueTag}-old.mp4`);

              fileInDirectory = `${saveAndServeFilesDirectory}/${channelUrl}/${uniqueTag}-old.mp4`;

              // convert video to libx264 and also compress if bitrate over 2500
              await ffmpegHelper.convertVideo({
                uploadedPath: fileInDirectory,
                title,
                bitrate,
                savePath,
                uniqueTag
              });

              uploadLogger.info('Finished converting file', logObject);

              // assuming an mp4 is created at this point so we delete the old uncoverted video
              await fs.remove(fileInDirectory);

            } else {
              // convert video to libx264 and also compress if bitrate over 2500
              await ffmpegHelper.convertVideo({
                uploadedPath: fileInDirectory,
                title: upload.title,
                bitrate,
                savePath,
                uniqueTag: upload.uniqueTag
              });

              uploadLogger.info('Finished converting file', logObject);

              // assuming an mp4 is created at this point so we delete the old uncoverted video
              await fs.remove(`${fileInDirectory}`);
            }

            uploadLogger.info('Deleted unconverted file', logObject);

            // for upload to b2
            fileInDirectory = `${channelUrlFolder}/${uniqueTag}.mp4`;

            upload.status = 'completed';

            upload.fileType = 'video';

            upload = await upload.save();

            uploadLogger.info('Completed video conversion', logObject);

          }

          /** UPLOAD VIDEO AND CONVERT IF NEEDED **/
          // TODO: fix b2 upload here
          if(upload.fileExtension == '.mp4' || upload.fileExtension == '.MP4'){

            // take a thumbnail using ffmpeg and save it to the document as uniqueTag.png
            // TODO: this also uploads to B2, this should be pulled out into its own fucntion
            await ffmpegHelper.takeAndUploadThumbnail(fileInDirectory, uniqueTag, hostFilePath, bucket, upload, channelUrl, b2);

            // if convertmp4 is true it means it was already converted
            if(bitrate > 2500 && convertMp4 !== true){

              // TODO: res.status here

              upload.status = 'processing';
              await upload.save();

              responseSent = true;
              res.send({
                message: 'ABOUT TO PROCESS',
                url: `/user/${channelUrl}/${uniqueTag}?autoplay=off`
              });

              uploadLogger.info('About to compress file since bitrate is over 2500', logObject);

              const savePath = `${saveAndServeFilesDirectory}/${channelUrl}/${uniqueTag}-compressed.mp4`;

              // compresses video ([ '-preset medium', '-b:v 1000k' ]); -> /${uniqueTag}-compressed.mp4
              await ffmpegHelper.compressVideo({
                uploadedPath: fileInDirectory,
                channelUrl,
                title: upload.title,
                savePath,
                uniqueTag: upload.uniqueTag
              });

              uploadLogger.info('Video file is compressed', logObject);

              // mark original upload file as high quality file
              await fs.move(fileInDirectory, `${channelUrlFolder}/${uniqueTag}-high.mp4`);

              // TODO: upload to b2 here?

              uploadLogger.info('Moved original filename to uniqueTag-high.mp4', logObject);

              // move compressed video to original video's place
              await fs.move(`${channelUrlFolder}/${uniqueTag}-compressed.mp4`, fileInDirectory);

              uploadLogger.info('Moved compressed file to default uniqueTag.mp4 location', logObject);

              // save high quality video size
              const highQualityFileStats = fs.statSync(`${channelUrlFolder}/${uniqueTag}-high.mp4`);
              upload.quality.high = highQualityFileStats.size;

              // save compressed video quality size
              const compressedFileStats = fs.statSync(fileInDirectory);
              upload.fileSize = compressedFileStats.size;

              // uploadLogger.info(`Moved file to user's directory`, logObject);

              ffmpegHelper.setRedisClient({ uniqueTag: upload.uniqueTag, progress: 100 })

              await upload.save();

              uploadLogger.info('Upload document saved after compression and moving files', logObject);

            }

          }

          /** UPLOAD IMAGE OR AUDIO **/
          if(upload.fileType == 'image' || upload.fileType == 'audio'){
            // everything is already done
          }

          /** UPLOAD TO B2 **/
          if(process.env.UPLOAD_TO_B2 == 'true'){
            await backblaze.uploadToB2(upload, fileInDirectory, hostFilePath);

            // indicates presence of compressed mp4, also upload that one, also if it's a convert mp4 it's already compressed so no need to upload
            if((upload.fileExtension == '.mp4' || upload.fileExtension == '.MP4') && bitrate > 2500 && convertMp4 !== true){

              console.log('UPLOADING THIS MP4 COMPRESSION TO BACKBLAZE');

              // name for b2 : hostFilePath + upload.fileExtension,

              const highQualityNameForB2 = `${channelUrl}/${uniqueTag}-high`;

              // file name to save
              const highQualityFileName = `${uniqueTag}-high.mp4`;

              // the full local path of where the file will be served from
              let highQualityFileInDirectory = `${channelUrlFolder}/${highQualityFileName}`;

              await backblaze.uploadToB2(upload, highQualityFileInDirectory, highQualityNameForB2);
            }
          }

          await uploadHelpers.markUploadAsComplete(uniqueTag, channelUrl, user);

          uploadLogger.info('Upload marked as complete', logObject);

          uploadHelpers.updateUsersUnreadSubscriptions(user);

          uploadLogger.info('Updated subscribed users subscriptions', logObject);

          if(!responseSent)
          {
            responseSent = true;
            res.send({
              message: 'DONE PROCESSING',
              url: `/user/${channelUrl}/${uniqueTag}?autoplay=off`
            });
          }
        });
      } else {
        res.send(status);
      }

    });

  } catch(err){
    console.log(err);
  }

};

/** TODO: pull into livestream **/
exports.adminUpload = async(req, res) => {

  console.log(req.headers);

  console.log('hit');

  if(req.headers.token !== 'token'){
    res.status = 403;
    return res.send('wrong');
  }

  const username = req.headers.username;
  const date = req.headers.date;

  console.log(date);

  let user = await User.findOne({ channelUrl: username });

  // if you cant find the user
  if(!user){
    console.log('NOT EXPECTED: NO USER');
    res.status(500);
    return res.send('wrong');
  }

  const channelUrl = user.channelUrl;

  const title = `Livestream by ${username} at ${date}`;

  const uniqueTag = randomstring.generate(7);

  const fileExtension = '.flv';

  let upload = new Upload({
    uploader: user._id,
    title,
    visibility: 'public',
    fileType : 'video',
    hostUrl,
    fileExtension : '.flv',
    uniqueTag,
    rating: 'allAges',
    status: 'processing',
    livestreamDate : date
    // uploadServer
  });

  await upload.save();

  const realFileInDirectory = `./uploads/${channelUrl}${uniqueTag}.flv`;

  let flvFile = fs.createWriteStream(realFileInDirectory);

  req.on('data', chunk => {

    flvFile.write(chunk);

  });

  req.on('end', async function(){

    flvFile.end();

    const hostFilePath = `${channelUrl}/${uniqueTag}`;

    await mkdirp.mkdirpAsync(`./uploads/${user.channelUrl}`);

    await ffmpegHelper.takeAndUploadThumbnail(realFileInDirectory, uniqueTag, hostFilePath, bucket, upload, channelUrl, b2);

    await ffmpegHelper.convertVideo({
      uploadedPath: realFileInDirectory,
      uniqueTag,
      channelUrl,
      title: upload.title
    });

    const response = await ffmpegHelper.ffprobePromise(realFileInDirectory);

    // console.log(response);

    upload.fileSize = response.format.size;

    upload.bitrate = response.format.bit_rate / 1000;

    upload.status = 'completed';
    upload.fileType = 'video';

    upload = await upload.save();

    console.log('done');

    await markUploadAsComplete(uniqueTag, channelUrl, user);

    res.send('done');

    updateUsersUnreadSubscriptions(user);

    /** UPLOAD TO B2 **/
    if(process.env.NODE_ENV == 'production'){
      uploadToB2(upload, realFileInDirectory, hostFilePath);
    }
  });

};
