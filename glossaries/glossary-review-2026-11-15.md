# Glossary review, 2026-11-15

Every entry of the original 806-entry glossary was tested on 1,224 real meeting rows (Jun 4, Sep 20, Sep 26, Nov 12, Nov 15, plus rows from the full history chosen to contain rarely used entries). Each row was translated twice: with the original glossary and with no glossary.

- Original (unique) entries: 805
- Kept: 557 (of which 29 had the English target corrected)
- Removed: 248
- Added: 3

The original file is untouched at `glossaries/ro-en-live-2026-05-24-backup.csv` and at `gs://mlf-gtranslate-glossaries/backup/`. To put any entry back, delete it from the REMOVE list in `build-restored-glossary.py`, run the script, and upload.

## Why entries were removed

A glossary entry forces one fixed English string wherever the Romanian word appears. That is right for names and JW terms. It breaks conjugated verbs (`spune,say` gives "Paul say"), function words (`trebuie,must` gives "must to succeed") and words inside idioms (`siguranță,safety` turns "cu siguranță" into "safety" when it means "certainly"). Without the entry, Google conjugates and reads the idiom correctly.

## Removed entries

"Seen" is how many test rows contain the word; "changed" is how many of those the entry altered. Entries marked "twin" are the no-diacritics spelling of a removed entry.

| Romanian | Forced English | Seen | Changed | Example (without entry, then with entry) |
|---|---|---|---|---|
| spune | say | 90 | 67 | "kind even if he says something totally" became "kindness even if say something totally" |
| trebuie | must | 61 | 35 | "over the world you have to succeed" became "over the world must to succeed" |
| văzut | seen | 30 | 22 | "saw the new" became "seen the new" |
| prieteni | friendship | 25 | 21 | "surrounded by quality friends. And when" became "surrounded by quality friendship . And when" |
| rugăm | Please | 29 | 20 | "us continue to pray with confidence" became "us continue to Please with trust" |
| ajută | help | 34 | 19 | "in life Who helps me succeed" became "in life Who help me succeed" |
| lucrarea | ministry | 19 | 18 | "linked to the work that praises" became "linked to the ministry that praises" |
| multe | many | 43 | 17 | "Bible translation and much more" became "Bible translation and many Other" |
| faptul | the fact | 23 | 15 | "project to do that promotes peace" became "project to do the fact promotes peace" |
| siguranță | safety | 17 | 15 | "Surely even if" became "Safety even though" |
| viața | life | 35 | 12 | "if we guide our lives according to" became "if we guide life according to" |
| prezent | present | 13 | 12 | "millions of people today 3 has" became "millions of people present 3 has" |
| există | exist | 12 | 11 | "there is a" became "exist is a" |
| început | start | 13 | 10 | "5 from the beginning 10,000 different" became "5 from the start 10,000 differently" |
| cauza | cause | 12 | 10 | "in Israel Reign because of these" became "in Israel Reign cause of these" |
| înțelegem | we understand | 14 | 9 |  |
| merită | deserve | 9 | 9 | "away. It is worth making friends" became "away. It is deserve making friends" |
| plăcut | pleasant | 11 | 9 | "and we really liked that I" became "and we really pleasant that I" |
| biblic | biblical | 9 | 8 | "You had a Bible study that" became "You had a Biblical study that" |
| crezi | you believe | 9 | 8 |  |
| vedere | view | 14 | 8 | "different at first glance from other" became "different at first view from other" |
| cinstiți | Honor | 10 | 8 | "easy to be honest even when" became "easy to be Honor even when" |
| indiferent | indifferent | 8 | 8 | "faith was strengthened. Regardless of age," became "faith was strengthened. Indifferent of age," |
| întotdeauna | ever | 8 | 8 | "we being imperfect Always Let us" became "we being imperfect Ever Let us" |
| lumea | the world | 23 | 8 | "interested in this world and" became "interested in this the world and" |
| tuturor | to everyone | 8 | 8 | "mentioned to us all" became "mentioned to us to everyone" |
| cuvântul | the word | 14 | 7 | "death attentively this word passes" became "death attentively this the word passes" |
| nevoie | need | 27 | 7 | "happy it is necessary that in" became "happy it is need that in" |
| totdeauna | always | 13 | 7 | "he will endure forever these are" became "he will endure always these are" |
| aproape | almost | 9 | 7 | "with him the closer we are" became "with him the almost we are" |
| bucura | joy | 6 | 6 | "my heart will rejoice my son" became "my heart will joy my son" |
| mulți | many | 18 | 6 | "effort and a lot of money" became "effort and a many of money" |
| nostru | our | 44 | 6 | "what happens inside us" became "what happens inside our" |
| timpul | time | 21 | 6 | "think now during school or" became "think now time school or" |
| veghe | watch | 9 | 6 | "time in a watchtower" became "time in a watch" |
| atenție | Careful | 6 | 6 | "better to listen carefully, perhaps ask" became "better to listen Careful , perhaps ask" |
| diferite | differently | 6 | 6 | "the beginning 10,000 different men that" became "the start 10,000 differently men that" |
| nimic | nothing | 17 | 6 | "you don't know anything wait I'll" became "you don't know nothing wait I'll" |
| spiritul | the spirit | 20 | 6 | "ministry of each spirit so" became "work of each the spirit so" |
| regele | the king | 12 | 6 | "and King David felt" became "and The king David felt" |
| adevărat | true | 18 | 5 | "and that he truly cares about" became "and that he true cares about" |
| înseamnă | means | 15 | 5 | "courage does not mean not feeling" became "Courage does not means not feel" |
| ajutorul | the help | 9 | 5 | "offers us help and" became "offers us the help and" |
| gândește | thinks | 7 | 5 | "next few days Think about this" became "the following days Thinks about this" |
| întâmplă | happen | 9 | 5 | "even if it happens Young man" became "even if it happen Young I" |
| păstrăm | we keep | 6 | 5 | "and striving to keep our" became "and striving to we keep family" |
| răspunde | respond | 5 | 5 | "how would you answer" became "how would you respond" |
| singur | single | 6 | 5 | "to recover on your own Of course" became "to recover on single Of course" |
| studiul | the study | 8 | 5 | "very busy and studying takes up" became "very busy and the study takes up" |
| vorbești | you speak | 5 | 5 | "personally like to talk to about" became "personally like to you speak to about" |
| cuvintele | the words | 10 | 5 | "his words are" became "his the words are" |
| inima | heart | 18 | 4 | "you with all our hearts for this" became "you with all heart for this" |
| noastră | our | 43 | 4 | "on us or on" became "on our or on" |
| așteaptă | Wait | 4 | 4 | "God because he expects a person" became "God because he Wait a person" |
| bucură | joy | 5 | 4 | "makes Jehovah's heart rejoice honors his" became "Jehovah 's heart joy honors his" |
| continui | content | 4 | 4 | "So you continue" became "Therefore content to you learn" |
| începe | start | 7 | 4 | "does this thing starts looking in" became "does this thing start looking in" |
| întreabă | ask | 4 | 4 | "in the class asks the 5th" became "in the class ask the 5th" |
| învăța | learn | 10 | 4 | "with airs of learning book students" became "with airs of learn book students" |
| materiale | materials | 6 | 4 | "online popularity, or material things can" became "online popularity, or materials things can" |
| acestei | of This | 13 | 4 | "some gravity around this friend" became "some gravity around of This friend" |
| asemănător | like | 4 | 4 | "into the distance. Similarly, the Bible" became "into the distance. Like, the Bible" |
| hotărât | decided | 5 | 4 | "experience. So be determined to cultivate" became "experience. Therefore be decided to cultivate" |
| părere | opinion | 5 | 4 | "at but with regret. Christian churches" became "at but with opinion . Christian churches" |
| părinților | fathers | 4 | 4 | "been superior to his parents and there" became "was superior to the fathers and you" |
| respectă | respect | 4 | 4 | "true God and keep his commandments" became "true God and respect his commandments" |
| Organizația | the Organization | 7 | 3 | "and uses your organization of imperfect" became "and use your the Organization of imperfect" |
| organizația | the Organization | 7 | 3 | "and uses your organization of imperfect" became "and use your the Organization of imperfect" |
| anume | certain | 6 | 3 | "His word the Bible, namely by studying" became "His word the Bible , certain by studying" |
| creat | creator | 4 | 3 | "fact Jehovah God created us with" became "fact Jehovah God creator us with" |
| exista | exist | 4 | 3 | "Moon no longer exists he will" became "Moon no longer exist he will" |
| înțelege | understand | 6 | 3 | "verse says everything he understands that" became "verse say everything understand that" |
| iubesc | I love | 7 | 3 | "a wife who love each" became "a wife who I love each" |
| pregătit | prepared | 9 | 3 | "I had to prepare for this" became "I had to prepared for this" |
| privire | look | 11 | 3 | "his original purpose regarding the planet" became "his original purpose look the planet" |
| punct | point | 7 | 3 | "you feed us spiritually and instruct" became "you feed us point and instruct" |
| viață | life | 31 | 3 | "having a simple lifestyle cultivating true" became "having a simple life cultivating true" |
| citești | you read | 3 | 3 | "Then learn to read and" became "Then learn to you read and" |
| continuă | continue | 3 | 3 | "principle, therefore Jehovah continues to give" became "principle, therefore Jehovah continue to give" |
| drept | justice | 5 | 3 | "us to be rightly offended, but" became "us to be justice offended, but" |
| folosește | use | 4 | 3 | "and uses your organization" became "and use your the" |
| folosim | we use | 5 | 3 | "Jehovah to be used to the" became "Jehovah to be we use to the" |
| importantă | importance | 3 | 3 | "made something more important in our" became "made something more importance in our" |
| învață | learn | 4 | 3 | "with me and teach me to" became "with me and learn me to" |
| înveți | you learn | 4 | 3 |  |
| observa | notice | 3 | 3 | "China we will see that Jehovah" became "China we will notice that Jehovah" |
| realiza | realize | 3 | 3 | "currently doing to achieve his goal" became "present doing to realize purpose" |
| schimbat | change | 4 | 3 | "about what has changed our lives, we are" became "about what has change life, we are" |
| situația | the situation | 7 | 3 | "about the critical situation in" became "about the critical the situation in" |
| ascultă | listen | 5 | 3 | "that lead to listening to the" became "that lead to listen to the" |
| atins | reached | 3 | 3 | "his hand and touched my mouth." became "his hand and reached my mouth." |
| clara | clear | 3 | 3 | "Without Clara this prophecy" became "Without Clear this prophecy" |
| curată | cleanse | 3 | 3 | "hygiene and a clean home we" became "hygiene and a cleanse home we" |
| plină | full | 6 | 3 | "a completely different spirit." became "a completely different full ." |
| rămână | stay | 3 | 3 | "only one question remains we have" became "only one question stay we have" |
| reușit | successful | 3 | 3 | "we haven't been able to do" became "we haven't been successful to do" |
| târziu | late | 3 | 3 | "thousands of years later long after" became "thousands of years late long after" |
| biblice | biblical | 11 | 2 | "to initiate and conduct Bible studies and" became "to initiate and lead Biblical studies and" |
| Societatea | the Society | 3 | 2 | "read, not human society was here." became "read, not human the Society was here." |
| alții | others | 18 | 2 | "closer to each other" became "closer to each others" |
| prietenii | friends | 23 | 2 | "might suggest some friendships to us." became "might suggest some friends to us." |
| simți | feel | 14 | 2 | "not mean not feeling fear and" became "not means not feel fear and" |
| carte | book | 10 | 2 | "school where no books are made." became "school where no book are made." |
| caută | search for | 3 | 2 | "those who diligently seek him and" became "those who diligently search for him and" |
| citește | read | 3 | 2 | "When he reads these verses," became "When read these verses," |
| conține | contain | 3 | 2 | "DNA contains a lot" became "DNA contain a lot" |
| curaj | Courage | 14 | 2 | "walk with him courageously. Read each" became "walk with him Courage . Read each" |
| dedici | commit | 2 | 2 | "will have to dedicate each week" became "will have to commit each week" |
| fizic | physical | 3 | 2 | "can overwhelm people Physically and" became "can overwhelm people Physical and" |
| încearcă | try | 8 | 2 | "way but Satan tries through this" became "way but Satan try through this" |
| învățat | learned | 6 | 2 | "a lot to learn Okay Let's" became "a many to learned Okay Let's" |
| numit | appointed | 4 | 2 | "Jerusalem will be called the throne" became "Jerusalem will be appointed the throne" |
| permite | allows | 4 | 2 | "world means not allowing the spirit" became "world means not allows the spirit" |
| place | like | 10 | 2 | "encouraging and even enjoy reading them" became "encouraging and even like reading them" |
| plăcută | pleasant | 3 | 2 | "the land that pleased the most" became "the land that pleasant the most" |
| promite | promise | 3 | 2 | "what's up God Promises What can" became "what's up God Promise What can" |
| schimbă | change | 5 | 2 | "suddenly her task changes, she says" became "suddenly her task change , she says" |
| simte | feels | 4 | 2 | "that he doesn't feel like doing." became "that he doesn't feels like doing." |
| susține | support | 4 | 2 | "understand that Jehovah supports his witnesses." became "understand that Jehovah support his witnesses" |
| altele | Other | 2 | 2 | "Bible translation and much more" became "Bible translation and many Other" |
| analizați | Review | 2 | 2 | "invite you to Consider the following" became "invite you to Review the following" |
| ascultat | listened to | 3 | 2 | "great sacrifices and obeyed Jehovah but" became "great sacrifices and listened to Jehovah but" |
| banii | the money | 3 | 2 | "with my pocket money because" became "with my pocket the money because" |
| conduce | lead | 5 | 2 | "to initiate and conduct Bible studies and" became "to initiate and lead Biblical studies and" |
| cunoaște | know | 6 | 2 | "the devil he knows this" became "the devil he know this" |
| determinat | determined | 2 | 2 | "all this series has made me want" became "all this series determined me want" |
| dreptul | right | 4 | 2 | "language I was overjoyed Jehovah can" became "language I was right Jehovah can" |
| locul | place | 8 | 2 | "only family after work you" became "only family after place work barely" |
| predică | preach | 3 | 2 | "the only ones preaching the good" became "the only ones preach the good" |
| prețuiește | cherish | 3 | 2 | "make but Jehovah Treasures us so" became "make but Jehovah Cherish us so" |
| problemele | the problems | 5 | 2 | "real problems his" became "real the problems his" |
| sluji | serve | 3 | 2 | "the privilege of serving Jehovah every" became "the privilege of serve Jehovah each" |
| studia | study | 3 | 2 | "at school, was studying the Bible" became "school , was study the Bible" |
| suferă | suffers | 6 | 2 | "it does not suffer from corruption" became "it does not suffers from corruption" |
| vorbește | speaks | 4 | 2 | "what he was talking about was" became "what he was speaks about was" |
| Faptele | Acts | 3 | 2 | "we want our deeds to be" became "we want our Acts to be" |
| ajutat | helped | 16 | 1 | "a means to help me reach" became "a means to helped me reach" |
| folosi | use | 8 | 1 | "food and after using" became "food and after use" |
| noastre | our | 35 | 1 | "feelings that bring us closer to" became "feelings that bring our closer to" |
| turnul | the tower | 3 | 1 | "of the magazine Turnul de Vegan" became "of the magazine The tower de Vegan" |
| ajute | help | 5 | 1 | "is style and helping them with" became "is style and help them with" |
| alege | choose | 4 | 1 | "the one who chooses to make" became "the one who choose to make" |
| aprobă | approve | 1 | 1 | "sure that Jehovah approves of the" became "sure that Jehovah approve of the" |
| binele | the good | 4 | 1 | "just for your own good for" became "just for your the good for" |
| continua | continue | 5 | 1 | "that the famine continues" became "that the famine continue" |
| deveni | become | 4 | 1 | "If your heart becomes wise my" became "If your heart become wise my" |
| dezvăluie | Reveals | 2 | 1 | "the Scriptures that reveal Jehovah's way of" became "the Scriptures that Reveals Jehovah 's way of" |
| folosit | used | 4 | 1 | "helped me to use what I" became "helped me to used what I" |
| inimă | heart | 5 | 1 | "the bottom of our hearts" became "the bottom of heart" |
| întreba | ask | 6 | 1 | "someone and he asked me, "Don't" became "someone and he ask me, "Don't" |
| iubești | love | 3 | 1 | "who still loves Jehovah is" became "who still love Jehovah is" |
| mesajul | the message | 3 | 1 | "showing that our message comes" became "showing that our the message comes" |
| murim | die | 2 | 1 | "you doing here, we are dying of hunger?" became "you doing here, die of hunger?" |
| placut | pleasant | 1 | 1 | "I liked this idea" became "I pleasant this idea" |
| rămâi | stay | 2 | 1 | "help you to remain loyal to" became "help you to stay loyal to" |
| rămâne | remain | 5 | 1 | "will of God remains forever." became "will of God remain always." |
| studiezi | you study | 2 | 1 | "Bible together or studied with them." became "Bible together or you study with them." |
| adevărații | real | 1 | 1 | "we identify the true worshipers of" became "we identify the real worshipers of" |
| clară | clear | 2 | 1 | "help us see clearly the public" became "help us see clear the public" |
| explica | explain | 1 | 1 | "although the brother explains in English" became "although the brother explain in English" |
| explică | explain | 1 | 1 | "with 36 Daniel Explains each part" became "with 36 Daniel Explain each part" |
| guverneze | governor | 1 | 1 | "kingdom begins to rule in heaven" became "kingdom start to governor in heaven" |
| ideea | the idea | 5 | 1 | "the very main idea is" became "the very main the idea is" |
| legile | the laws | 2 | 1 | "according to His laws right" became "according to His the laws right" |
| limba | language | 6 | 1 | "interesting in Hebrew and almond" became "interesting in Language and almond" |
| lupta | fight | 2 | 1 | "the nature of fighting each other" became "the nature of fight each other" |
| motiv | reason | 3 | 1 | "would save mankind, so God could" became "would save mankind, reason God could" |
| natură | nature | 3 | 1 | "in such a way that the" became "in such a nature that the" |
| observă | notice | 2 | 1 | "follow Satan Jehovah notices that we" became "follow Satan Jehovah notice that we" |
| participa | participate | 2 | 1 | "this habit of participating, but it's" became "this habit of participate , but it's" |
| perioada | period | 3 | 1 | "think a little during the pandemic" became "think a little period the pandemic" |
| persevera | persevere | 4 | 1 | "lack flowed Joseph persevered courageously" became "lack flowed Joseph persevere Courage" |
| pregăti | prepare | 3 | 1 | "data very well prepared a few" became "data very well prepare a few" |
| prețuim | cherish | 2 | 1 | "congregation whom we value as much" became "congregation whom we cherish as much" |
| problema | problem | 6 | 1 | "know it will backfire on them." became "know it will problem on them." |
| scris | written | 5 | 1 | "they also wrote their mistakes" became "they also written their mistakes" |
| adevarat | true | 0 | 0 | twin / same defect as a measured entry |
| ajuta | help | 26 | 0 | twin / same defect as a measured entry |
| altii | others | 0 | 0 | twin / same defect as a measured entry |
| cititi | Read | 0 | 0 | twin / same defect as a measured entry |
| citiți | read | 0 | 0 | twin / same defect as a measured entry |
| cuvantul | the word | 0 | 0 | twin / same defect as a measured entry |
| inceput | start | 0 | 0 | twin / same defect as a measured entry |
| inseamna | means | 0 | 0 | twin / same defect as a measured entry |
| intelege | understand | 0 | 0 | twin / same defect as a measured entry |
| invata | learn | 0 | 0 | twin / same defect as a measured entry |
| multi | many | 0 | 0 | twin / same defect as a measured entry |
| noastra | our | 0 | 0 | twin / same defect as a measured entry |
| predica | preach | 2 | 0 | twin / same defect as a measured entry |
| schimba | change | 3 | 0 | twin / same defect as a measured entry |
| simti | feel | 0 | 0 | twin / same defect as a measured entry |
| viata | life | 0 | 0 | twin / same defect as a measured entry |
| aproba | approve | 0 | 0 | twin / same defect as a measured entry |
| asculta | listen | 3 | 0 | twin / same defect as a measured entry |
| asteapta | Wait | 0 | 0 | twin / same defect as a measured entry |
| atentie | Careful | 0 | 0 | twin / same defect as a measured entry |
| bucuram | enjoy | 0 | 0 | twin / same defect as a measured entry |
| cauta | search for | 0 | 0 | twin / same defect as a measured entry |
| cinstiti | honest | 0 | 0 | twin / same defect as a measured entry |
| citeste | read | 0 | 0 | twin / same defect as a measured entry |
| citesti | you read | 0 | 0 | twin / same defect as a measured entry |
| contine | contain | 0 | 0 | twin / same defect as a measured entry |
| cunosti | know | 0 | 0 | twin / same defect as a measured entry |
| decizia | Decision | 6 | 0 | twin / same defect as a measured entry |
| dezvaluie | reveal | 0 | 0 | twin / same defect as a measured entry |
| importanta | importance | 0 | 0 | twin / same defect as a measured entry |
| incearca | try | 0 | 0 | twin / same defect as a measured entry |
| incepe | start | 0 | 0 | twin / same defect as a measured entry |
| intampla | happen | 0 | 0 | twin / same defect as a measured entry |
| intelegem | we understand | 0 | 0 | twin / same defect as a measured entry |
| intotdeauna | ever | 0 | 0 | twin / same defect as a measured entry |
| intreaba | ask | 0 | 0 | twin / same defect as a measured entry |
| intreba | ask | 0 | 0 | twin / same defect as a measured entry |
| invatam | learn | 0 | 0 | twin / same defect as a measured entry |
| invatat | learned | 0 | 0 | twin / same defect as a measured entry |
| inveti | you learn | 0 | 0 | twin / same defect as a measured entry |
| merita | deserve | 1 | 0 | twin / same defect as a measured entry |
| natura | nature | 3 | 0 | twin / same defect as a measured entry |
| pastram | we keep | 0 | 0 | twin / same defect as a measured entry |
| plăcuți | please | 1 | 0 | twin / same defect as a measured entry |
| pregatit | prepared | 0 | 0 | twin / same defect as a measured entry |
| ramane | remain | 0 | 0 | twin / same defect as a measured entry |
| raspunde | respond | 0 | 0 | twin / same defect as a measured entry |
| respecta | respect | 1 | 0 | twin / same defect as a measured entry |
| respectam | We respect | 0 | 0 | twin / same defect as a measured entry |
| rugam | Please | 0 | 0 | twin / same defect as a measured entry |
| situatia | the situation | 0 | 0 | twin / same defect as a measured entry |
| sustine | support | 0 | 0 | twin / same defect as a measured entry |
| vorbesti | you speak | 0 | 0 | twin / same defect as a measured entry |
| analizati | analyze | 0 | 0 | twin / same defect as a measured entry |
| asemanator | like | 0 | 0 | twin / same defect as a measured entry |
| conducatori | lead | 0 | 0 | twin / same defect as a measured entry |
| cunoaste | know | 0 | 0 | twin / same defect as a measured entry |
| curata | cleanse | 0 | 0 | twin / same defect as a measured entry |
| folosești | use | 1 | 0 | twin / same defect as a measured entry |
| parere | opinion | 0 | 0 | twin / same defect as a measured entry |
| parintilor | parents | 0 | 0 | twin / same defect as a measured entry |
| predicam | preaching | 0 | 0 | twin / same defect as a measured entry |
| pregati | prepare | 0 | 0 | twin / same defect as a measured entry |
| pretuieste | Cherish | 0 | 0 | twin / same defect as a measured entry |
| ramai | remain | 0 | 0 | twin / same defect as a measured entry |
| reusit | successful | 0 | 0 | twin / same defect as a measured entry |
| siguranta | safety | 0 | 0 | twin / same defect as a measured entry |
| sufera | suffer | 0 | 0 | twin / same defect as a measured entry |
| suferim | suffer | 2 | 0 | twin / same defect as a measured entry |
| tarziu | late | 0 | 0 | twin / same defect as a measured entry |
| vazut | seen | 0 | 0 | twin / same defect as a measured entry |
| vorbeste | speaks | 0 | 0 | twin / same defect as a measured entry |

## Corrected entries

| Romanian | Was | Now |
|---|---|---|
| batranii | elderly | elders |
| congregația | Congregation | congregation |
| intrebari | question | questions |
| întrebări | question | questions |
| lecția | Lesson | lesson |
| batrani | old | elders |
| capitolul | Chapter | chapter |
| discipolii | followers | disciples |
| divertismente | Entertainment | entertainment |
| evenimente | event | events |
| familiei | Family | family |
| fidel | faithfully | faithful |
| medicale | physician | medical |
| prevazator | cautious | discreet |
| prevăzător | cautious | discreet |
| sărbători | celebrate | holidays |
| schimbari | change | changes |
| schimbări | change | changes |
| sfaturi | tips | advice |
| batranilor | elderly | elders |
| bătrânilor | elderly | elders |
| carti | book | books |
| cărți | book | books |
| creștinilor | Christian | Christians |
| exemplul | Example | example |
| intrunire | meet | meeting |
| întrunire | meet | meeting |
| loiali | loyalty | loyal |
| sărbătorile | Holidays | holidays |

## Added

| Romanian | English |
|---|---|
| turn de veghe | Watchtower |
| sclavul fidel și prevăzător | the faithful and discreet slave |
| Faptele apostolilor | Acts |

## Result on the test rows

| | Original 806 | Restored 560 | No glossary |
|---|---|---|---|
| Broken-grammar hits, 2026-11-15 meeting (136 rows) | 52 | 5 | 7 |
| Broken-grammar hits, all 1,224 rows | 262 | 17 | 20 |
| "convention" (not "congress") | 5 | 5 | 2 |
| "Philippians" | 7 | 7 | 5 |
| "James" (Iacov) | 4 | 4 | 2 |
| "discreet" (slave) | 0 | 4 | 3 |
