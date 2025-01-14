const { readFileSync, writeFileSync, existsSync } = require('fs')

const Discord = require('discord.js');
require('dotenv').config();
const scheduler = require('node-schedule');

const RoomCheck = require('./room-check.js')
const Timetable = require('./timetable.js')
const DiscordFunctions = require('./discord-functions.js')


const client = new Discord.Client({ intents: [Discord.GatewayIntentBits.DirectMessages] });

client.on('ready', async () => {
  console.log(`${client.user.username} is online!`);
  // If the file doesn't exist, make it.
  if (!existsSync('./user-data.json')) {
    const userData = {}; const channelData = {}
    writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))
  }

  scheduler.scheduleJob('0 6 * * *', () => {timetableUpdate(false)})
  scheduler.scheduleJob('0 18 * * *', () => {timetableUpdate(true)})
  scheduler.scheduleJob('0 0 1 9 *', () => {updateCourseIDs()})
});

// The daily update function
async function timetableUpdate(nextDay) {
  let { userData, channelData } = await JSON.parse(readFileSync('./user-data.json'))

  userData = await parseData(userData, nextDay, 'user')
  channelData = await parseData(channelData, nextDay, 'channel')

  writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))
}

// This function iterates over the dict asynchronously
// If any errors arrise on an entry, it's removed from the dict. Ignore the catch jank, JS's promise syntax could be better.
// The new dict is returned, to be written onto the file on disk.
async function parseData(dataObject, nextDay, mode) {
  await Promise.allSettled(Object.entries(dataObject).map(async function ([targetChannelID, optionData]) {
    if (optionData.nextDay == nextDay) {
      let targetObject
      try {
        if (mode == 'channel') {
          targetObject = await client.channels.fetch(targetChannelID).catch(() => {throw new Error(`Failed to find channel with ID '${targetChannelID}'`)})
        } else {
          targetObject = await client.users.fetch(targetChannelID).catch(() => {throw new Error(`Failed to find user with ID '${targetChannelID}'`)})
        }
        const courseID = await Timetable.fetchCourseData(optionData.courseCode)
        const offset = optionData.nextDay ? 1 : 0
        sendTimetableToChannel(targetObject, courseID, offset, optionData.ignoreTutorials)
      } catch (err) {
        console.error(`${err}, removing from database\n`)
        delete dataObject[targetChannelID]
      }
    }
  }))
  return dataObject
}

// At the end of each year, your course code should change. This will update it, provided the new code exists.
async function updateCourseIDs() {
  let { userData, channelData } = await JSON.parse(readFileSync('./user-data.json'))
  for (dataObject of [userData, channelData]) {
    await Promise.allSettled(Object.entries(dataObject).map(async function ([targetChannelID, optionData]) {
    if (optionData.autoUpdate == true) {
      let courseCode = optionData.courseCode
      courseCode = courseCode.slice(0, -1) + (parseInt(courseCode.slice(-1)) + 1).toString()
      try {
        await Timetable.fetchCourseData(courseCode)
      } catch {
        console.log(`The course '${courseCode}' doesn't seem to exist. Deleting ${targetChannelID} from database.`)
        return delete dataObject[targetChannelID]
      }
      optionData.courseCode = courseCode
    }
  }))
  }
  writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const { commandName } = interaction;

  if (commandName === 'ping') {
    return await interaction.reply('Pong!');
  }

  if (commandName === 'timetable') {
    await interaction.deferReply()
    const courseCode = interaction.options.getString('course').split(' ')[0].toUpperCase();
    const courseID = await Timetable.fetchCourseData(courseCode).catch(err => {/*console.error(err)*/});
    // this seems to take a while. perhaps we should cache these.

    if (courseID == undefined) {
      let embed = DiscordFunctions.buildErrorEmbed(commandName, `No courses found for code \`${courseCode}\``, `Did you spell it correctly?`);
      return await interaction.followUp({ embeds: [embed] });
    };

    const shortDay = ['mon', 'tue', 'wed', 'thu', 'fri']
    const longDay = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    let day = Timetable.fetchDay();

    if (interaction.options.getString('day') || interaction.options.getString('course').split(' ')[1]) {
      day = interaction.options.getString('day') || interaction.options.getString('course').split(' ')[1];
      day = day.toLowerCase()
      if (!shortDay.includes(day) && !longDay.includes(day)) return await interaction.followUp({ content: `\`${day}\` doesn't seem to be a valid day.`});

      if (day.length > 3) {
        day = longDay.find(toFind => toFind == day)
        day = day.charAt(0).toUpperCase() + day.slice(1)
      } else {
        day = longDay[shortDay.indexOf(day)]
        day = day.charAt(0).toUpperCase() + day.slice(1)
      }
    }
    let dateObject = new Date()
    day = Timetable.weekdays.indexOf(day)
    offset = dateObject.getDay() - day
    // offset the date as is appropriate.
    // offset is the diff between the current day and the day we want.
    dateObject.setDate(dateObject.getDate() - offset)
    dateObject.setHours(8, 0, 0, 0)
    let startDate = dateObject.toISOString()
    dateObject.setHours(22, 0, 0, 0)
    let endDate = dateObject.toISOString()

    Timetable.fetchRawTimetableData(courseID, startDate, endDate, 'programme')
      .then(async (res) => {
        res = res.CategoryEvents[0]
        if (res.Results < 1) {
          let embed = DiscordFunctions.buildErrorEmbed(commandName, `No events found for \`${res.Name ?? courseCode}\``)
          return await interaction.followUp({ embeds: [embed] });
        }

        let embed = new Discord.EmbedBuilder()
          .setTitle(`${res.Name ?? courseCode} timetable for ${dateObject.toLocaleDateString('en-US', {weekday: 'long'})}`)
          .setColor('Green');

        embed = DiscordFunctions.parseEvents(res.Results, embed)

        return await interaction.followUp({ embeds: [embed] });
      });
  }

  if (commandName === 'checkrooms' || commandName === 'labfree') {
    await interaction.deferReply();
    let errorEmbed = DiscordFunctions.buildErrorEmbed(commandName);
    let timeRange = interaction.options.getString('times');
    [errorEmbed, timeRange, timeRangeISO] = RoomCheck.generateTimeRange(errorEmbed, timeRange)

    let roomCodes = ['LG25', 'LG26', 'LG27', 'L101', 'L114', 'L125', 'L128', 'L129'];
    if (commandName === 'checkrooms') roomCodes = interaction.options.getString('rooms').toUpperCase().split(/\s/);
  
    const embedsToSend = await RoomCheck.checkRoom(errorEmbed, roomCodes, timeRange, timeRangeISO);
    return await interaction.followUp({ embeds: embedsToSend });
  }

  if (commandName === 'updateme') {
    await interaction.deferReply({ephemeral: true})
    const userID = interaction.user.id
    let courseCode = interaction.options.getString('course')
    courseCode ??= ''
    courseCode = courseCode.toUpperCase()
    
    let { userData, channelData } = await JSON.parse(readFileSync('./user-data.json'))

    // If blank, unregister
    if (courseCode == '') {
      if (userID in userData) {
        try {
          delete userData[userID]
          writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))
        } catch (err) {
          console.error(err)
          return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, `You are in the database, but couldn't be removed`, 'This shouldn\'t happen.')]})
        }
        const outputEmbed = new Discord.EmbedBuilder()
        .setTitle('Successfully unregistered')
        .setColor('Green')
        .addFields({"name": `You will no longer receive updates`, "value": '\u200b'})

        return await interaction.followUp({embeds: [outputEmbed]})
      } else {
          return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, 'You aren\'t in the database.', 'There is nothing to remove.')]})
      }
    }

    try {
      courseCode = await Timetable.fetchCourseData(courseCode, 'Name')
      const nextDay = interaction.options.getBoolean('nextday') || false
      const ignoreTutorials = interaction.options.getBoolean('ignoretutorials') || false
      const autoUpdate = interaction.options.getBoolean('autoupdate') || false
      
      userData[userID] = {'courseCode': courseCode, 'nextDay': nextDay, 'ignoreTutorials': ignoreTutorials, 'autoUpdate': autoUpdate}
      writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))

      let infoString = ''
      infoString += nextDay ? 'You will receive your timetable the day before at `18:00`.\n' : 'You will receive your timetable in the morning at `6:00`.\n'
      infoString += ignoreTutorials ? `Tutorials will be filtered from your timetable, provided they're set right in the event data.\n` : ''
      infoString += autoUpdate ? `Your course code will be updated year-by-year.\n` : ''

      const outputEmbed = new Discord.EmbedBuilder()
        .setTitle('Successfully registered')
        .setColor('Green')
        .addFields({"name": `You will receive updates for \`${courseCode}\``, "value": infoString})

      return await interaction.followUp({embeds: [outputEmbed]})
    } catch (err) {
      return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, `The course '\`${courseCode}\`' was not found.`, 'Did you spell it correctly?')]})
    }
  }

  if (commandName === "myinfo") {
    await interaction.deferReply({ephemeral: true})
    const userID = interaction.user.id
    let { userData } = await JSON.parse(readFileSync('./user-data.json'))
    if (userID in userData) {
      userData = Object.entries(userData[userID])
      infoString = ''
      for ([key, value] of userData) {
        infoString += `${key}: \`${value}\`\n`
      }
      const outputEmbed = new Discord.EmbedBuilder()
        .setTitle(`Your info`)
        .setColor('Green')
        .addFields({"name": `Please excuse this janky embed :smiling_face_with_tear:`, "value": infoString})
      return await interaction.followUp({embeds: [outputEmbed]})
    } else {
      return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, 'You aren\'t in the database.', '\u200b')]})
    }
  }

  if (commandName === 'updatechannel') {
    await interaction.deferReply({ephemeral: true})
    const channelID = interaction.channelId
    let courseCode = interaction.options.getString('course')
    courseCode ??= ''
    courseCode = courseCode.toUpperCase()
    
    let { userData, channelData } = await JSON.parse(readFileSync('./user-data.json'))

    // If blank, unregister
    if (courseCode == '') {
      if (channelID in channelData) {
        try {
          delete channelData[channelID]
          writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))
        } catch (err) {
          console.error(err)
          return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, `This channel is in the database, but couldn't be removed`, 'This shouldn\'t happen.')]})
        }
        const outputEmbed = new Discord.EmbedBuilder()
        .setTitle('Successfully unregistered')
        .setColor('Green')
        .addFields({"name": `This channel will no longer receive updates`, "value": '\u200b'})

        return await interaction.followUp({embeds: [outputEmbed]})
      } else {
          return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, 'This channel is not in the database.', 'There is nothing to remove.')]})
      }
    }

    try {
      courseCode = await Timetable.fetchCourseData(courseCode, 'Name')
      const nextDay = interaction.options.getBoolean('nextday') || false
      const ignoreTutorials = interaction.options.getBoolean('ignoretutorials') || false
      const autoUpdate = interaction.options.getBoolean('autoupdate') || false
      
      channelData[channelID] = {'courseCode': courseCode, 'nextDay': nextDay, 'ignoreTutorials': ignoreTutorials, 'autoUpdate': autoUpdate}
      writeFileSync('./user-data.json', JSON.stringify({ userData, channelData }, null, 2))

      let infoString = ''
      infoString += nextDay ? 'This channel will receive the timetable the day before at `18:00`.\n' : 'This channel will receive the timetable in the morning at `6:00`.\n'
      infoString += ignoreTutorials ? `Tutorials will be filtered from the timetable, provided they're set right in the event data.\n` : ''
      infoString += autoUpdate ? `The course code will be updated year-by-year.\n` : ''

      const outputEmbed = new Discord.EmbedBuilder()
        .setTitle('Successfully registered')
        .setColor('Green')
        .addFields({"name": `This channel will receive updates for \`${courseCode}\``, "value": infoString})

      return await interaction.followUp({embeds: [outputEmbed]})
    } catch (err) {
      return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, `The course '\`${courseCode}\`' was not found.`, 'Did you spell it correctly?')]})
    }
  }

  if (commandName === "channelinfo") {
    await interaction.deferReply({ephemeral: true})
    const channelID = interaction.channelId
    let { channelData } = await JSON.parse(readFileSync('./user-data.json'))
    if (channelID in channelData) {
      channelData = Object.entries(channelData[channelID])
      infoString = ''
      for ([key, value] of channelData) {
        infoString += `${key}: \`${value}\`\n`
      }
      const outputEmbed = new Discord.EmbedBuilder()
        .setTitle(`Channel info`)
        .setColor('Green')
        .addFields({"name": `Please excuse this ugly embed :smiling_face_with_tear:`, "value": infoString})
      return await interaction.followUp({embeds: [outputEmbed]})
    } else {
      return await interaction.followUp({embeds: [DiscordFunctions.buildErrorEmbed(commandName, `This channel isn't in the database.`, '\u200b')]})
    }
  }
});

/**
 * @param {Discord.User} target
 * @param {String} courseID
 * @param {Int} offset
 */
const sendTimetableToChannel = async function (target, courseID, offset, ignoreTutorials) {
    const dateToFetch = new Date()
    dateToFetch.setDate(dateToFetch.getDate() + offset)
    dateToFetch.setHours(8)
    const startDate = dateToFetch.toISOString()
    dateToFetch.setHours(22)
    const endDate = dateToFetch.toISOString()
    // not sure of the best way to deal with the nested promise causing an unhandled error, but this one works.
    // let courseID
    // try {courseID = await Timetable.fetchCourseData(courseCode)} catch {return true}

    Timetable.fetchRawTimetableData(courseID, startDate, endDate, 'programme')
      .then(async (res) => {
        res = res.CategoryEvents[0]
        if (res.Results.length < 1) return
        let embed = new Discord.EmbedBuilder()
          .setTitle(`${res.Name ?? courseID} Timetable for ${dateToFetch.toDateString()}`)
          .setColor('Green');
        try {
        embed = DiscordFunctions.parseEvents(res.Results, embed, ignoreTutorials).setDescription(`Times shown are in \`${new Date().toString().split(' ')[5].slice(0, 6)}\``)
        target.send({ embeds: [embed] }).catch(console.error);
        } catch (err) {
          console.error(err)
        }
      }).catch(console.error);
}

client.login(process.env.BOT_TOKEN);