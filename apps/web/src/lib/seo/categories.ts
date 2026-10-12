export interface CategoryDefinition {
  slug: string;
  name: string;
  title: string;
  description: string;
  intro: string;
  tags: string[];
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    slug: 'phim',
    name: 'Phim',
    title: 'Phim hay chọn lọc, phim lẻ và phim chiếu rạp mới nhất',
    description:
      'Tổng hợp phim hay chọn lọc trên Winkey: phim lẻ, hành động, cổ trang, kinh dị và tình cảm hấp dẫn. Thưởng thức trọn vẹn phim chất lượng cao miễn phí.',
    intro:
      'Chào mừng bạn đến với chuyên mục Phim trên Winkey. Nơi tổng hợp các bộ phim lẻ, phim chiếu rạp, phim hành động và tình cảm đặc sắc nhất. Hãy thưởng thức những tác phẩm điện ảnh đỉnh cao với chất lượng tuyệt hảo.',
    tags: ['phim', 'phim-le', 'phim-hay', 'co-trang', 'hanh-dong', 'kinh-di', 'tinh-cam'],
  },
  {
    slug: 'phim-bo',
    name: 'Phim bộ',
    title: 'Phim bộ đặc sắc, phim dài tập và series truyền hình chọn lọc',
    description:
      'Xem phim bộ hay, phim dài tập và các series truyền hình hấp dẫn được tuyển chọn trên Winkey. Cập nhật tập mới liên tục với chất lượng hình ảnh sắc nét.',
    intro:
      'Khám phá tuyển tập phim bộ hấp dẫn cùng các series truyền hình đặc sắc trên Winkey. Theo dõi trọn vẹn từng tập phim với cốt truyện lôi cuốn và diễn xuất ấn tượng. Trải nghiệm giải trí dài tập đỉnh cao mỗi ngày.',
    tags: ['phim-bo', 'series'],
  },
  {
    slug: 'am-nhac',
    name: 'Âm nhạc',
    title: 'Âm nhạc thịnh hành, MV ca nhạc và giai điệu tuyển chọn',
    description:
      'Thưởng thức thế giới âm nhạc sống động trên Winkey với các MV mới nhất, nhạc trẻ thịnh hành, bolero trữ tình và rap cuốn hút từ nhiều nghệ sĩ hàng đầu.',
    intro:
      'Không gian âm nhạc tuyệt vời dành cho người yêu nghệ thuật trên Winkey. Khám phá các MV ca nhạc mới nhất, những bản tình ca bất hủ và giai điệu rap sôi động. Lắng nghe và cảm nhận nhịp đập âm nhạc yêu thích của bạn.',
    tags: ['am-nhac', 'nhac', 'music', 'nhac-tre', 'bolero', 'rap'],
  },
  {
    slug: 'game',
    name: 'Game',
    title: 'Video game đỉnh cao, livestream và highlights trò chơi hấp dẫn',
    description:
      'Khám phá video game đặc sắc trên Winkey: highlights Liên Quân, Free Fire, Minecraft cùng các buổi phát trực tiếp và pha xử lý kịch tính từ streamer.',
    intro:
      'Khu vực dành riêng cho cộng đồng game thủ và người yêu thể thao điện tử trên Winkey. Cập nhật những pha xử lý đỉnh cao từ Liên Quân Mobile, Free Fire và Minecraft. Theo dõi những trận đấu nảy lửa và khoảnh khắc ấn tượng từ các streamer hàng đầu.',
    tags: ['game', 'gaming', 'lien-quan', 'free-fire', 'minecraft'],
  },
  {
    slug: 'hai-huoc',
    name: 'Hài hước',
    title: 'Video hài hước, tiểu phẩm vui nhộn và khoảnh khắc giải trí',
    description:
      'Thư giãn cùng kho video hài hước chọn lọc trên Winkey: tiểu phẩm vui nhộn, tình huống bất ngờ và tràng cười sảng khoái mang lại niềm vui mỗi ngày cho bạn.',
    intro:
      'Mang lại tiếng cười sảng khoái và phút giây thư giãn tuyệt vời tại Winkey. Tổng hợp các video hài hước, tiểu phẩm duyên dáng và tình huống bất ngờ thú vị. Hãy để niềm vui lan tỏa sau những giờ làm việc căng thẳng.',
    tags: ['hai-huoc', 'hai', 'funny'],
  },
  {
    slug: 'giai-tri',
    name: 'Giải trí',
    title: 'Giải trí tổng hợp, tin tức showbiz và talkshow hấp dẫn',
    description:
      'Không gian giải trí đa dạng trên Winkey: chương trình talkshow đặc sắc, hậu trường showbiz cùng những video thịnh hành mang đến phút giây thư giãn tuyệt vời.',
    intro:
      'Thế giới giải trí phong phú với những chương trình truyền hình và talkshow hấp dẫn trên Winkey. Cập nhật những xu hướng mới nhất cùng câu chuyện hậu trường thú vị từ người nổi tiếng. Tận hưởng không gian thư giãn trọn vẹn mỗi ngày.',
    tags: ['giai-tri', 'showbiz', 'talkshow'],
  },
  {
    slug: 'the-thao',
    name: 'Thể thao',
    title: 'Video thể thao sôi động, highlights bóng đá và khoảnh khắc ấn tượng',
    description:
      'Theo dõi video thể thao sôi động trên Winkey: điểm tin bóng đá, highlights bàn thắng mãn nhãn và các khoảnh khắc thi đấu kịch tính từ các giải đấu lớn.',
    intro:
      'Đắm chìm vào những khoảnh khắc thể thao nghẹt thở và đầy cảm xúc trên Winkey. Theo dõi những pha ghi bàn đẹp mắt, điểm tin bóng đá nóng hổi và phân tích chiến thuật đặc sắc. Đồng hành cùng những giải đấu hàng đầu thế giới.',
    tags: ['the-thao', 'bong-da'],
  },
  {
    slug: 'hoat-hinh',
    name: 'Hoạt hình',
    title: 'Phim hoạt hình hay, anime đặc sắc và câu chuyện lôi cuốn',
    description:
      'Thế giới hoạt hình đa sắc màu trên Winkey với các bộ anime hấp dẫn, phim thiếu nhi ý nghĩa cùng câu chuyện phiêu lưu lôi cuốn dành cho mọi lứa tuổi.',
    intro:
      'Khám phá thế giới hoạt hình kỳ diệu và những bộ anime đặc sắc tại Winkey. Nơi hội tụ các câu chuyện phiêu lưu kỳ thú, hình ảnh sống động và thông điệp ý nghĩa cho mọi lứa tuổi. Thưởng thức những thước phim hoạt hình yêu thích ngay hôm nay.',
    tags: ['hoat-hinh', 'anime'],
  },
];

export function getAllCategories(): CategoryDefinition[] {
  return [...CATEGORIES];
}

export function getCategory(slug: string): CategoryDefinition | undefined {
  return CATEGORIES.find((cat) => cat.slug === slug);
}

export function isCategorySlug(slug: string): boolean {
  return CATEGORIES.some((cat) => cat.slug === slug);
}
